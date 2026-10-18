import type { RequestOptions } from "../../../../../client/types.ts"
import type { Answer, Responder } from "../../../__fixtures__/harness.ts"

/*
 * An in-memory notes backend under `/orgs/{org}/notes`. Each credential belongs to one org; a
 * correct backend serves and changes a note only for a caller in the note's org, through that
 * org's path. The switches turn on one defect each, the way the reference server misbehaves.
 */

export interface BackendOptions {
	/** Credential → the org it belongs to. */
	members: Record<string, string>
	/** Writes look the note up by id alone, in any org, for any caller. */
	writesById?: boolean
	/** Whether `caller` may `kind` (create, update, delete) at all; default yes. */
	may?: (caller: string, kind: "create" | "update" | "delete") => boolean
	/** Status of a create; default 201. */
	createStatus?: number
}

type Note = Record<string, unknown>

function bodyOf(options: RequestOptions): Note {
	const body = options.body
	if (typeof body === "string") return JSON.parse(body) as Note
	return (body ?? {}) as Note
}

type Kind = "create" | "update" | "delete"

/** One request as the backend reads it. */
interface Call {
	method: string
	org: string
	id: string | undefined
	member: boolean
	request: RequestOptions
}

/** The backend's notes, by org, and how a write finds one. */
class Store {
	readonly notes = new Map<string, Map<string, Note>>()
	readonly #options: BackendOptions
	#made = 0

	constructor(options: BackendOptions) {
		this.#options = options
	}

	of(org: string): Map<string, Note> {
		const held = this.notes.get(org) ?? new Map<string, Note>()
		this.notes.set(org, held)
		return held
	}

	create(call: Call): Answer {
		if (!call.member) return { status: 404 }
		this.#made += 1
		const note = { ...bodyOf(call.request), id: `s${this.#made}` }
		this.of(call.org).set(String(note.id), note)
		return { body: note, status: this.#options.createStatus ?? 201 }
	}

	read({ id, member, org }: Call): Answer {
		if (!member) return { status: 404 }
		if (id === undefined) return { body: [...this.of(org).values()], status: 200 }
		const note = this.of(org).get(id)
		return note === undefined ? { status: 404 } : { body: note, status: 200 }
	}

	write(call: Call, id: string): Answer {
		const held = this.#holder(call, id)
		if (held === undefined) return { status: 404 }
		if (call.method === "DELETE") {
			held.delete(id)
			return { status: 204 }
		}
		const note = { ...held.get(id), ...bodyOf(call.request), id }
		held.set(id, note)
		return { body: note, status: 200 }
	}

	/* A correct backend looks in the caller's own org; the defect looks everywhere. */
	#holder({ member, org }: Call, id: string): Map<string, Note> | undefined {
		if (this.#options.writesById === true) return [...this.notes.values()].find((held) => held.has(id))
		return member && this.of(org).has(id) ? this.of(org) : undefined
	}
}

function kindOf(method: string): Kind {
	if (method === "POST") return "create"
	return method === "DELETE" ? "delete" : "update"
}

export function notesBackend(options: BackendOptions): Responder & { notes: Map<string, Map<string, Note>> } {
	const store = new Store(options)
	const respond = (method: string, path: string, request: RequestOptions): Answer => {
		const caller = (request.headers as Record<string, string> | undefined)?.authorization ?? ""
		const [, , org = "", , id] = path.split("/")
		const call = { id, member: options.members[caller] === org, method, org, request }
		if (method === "GET") return store.read(call)
		if (options.may?.(caller, kindOf(method)) === false) return { status: 403 }
		if (method === "POST") return store.create(call)
		return id === undefined ? { status: 405 } : store.write(call, id)
	}
	return Object.assign(respond, { notes: store.notes })
}
