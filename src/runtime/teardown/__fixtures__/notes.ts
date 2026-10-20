import type { OpenApiDocument } from "../../../spec/types.ts"
import type { SpecModel } from "../../../spec/graph/types.ts"
import type { RequestOptions } from "../../../client/types.ts"
import { type Answer, fakeClient, modelOf, type Responder } from "../../checks/__fixtures__/harness.ts"
import type { Unwind } from "../remove.ts"
import type { Disposable, Owner } from "../types.ts"

/*
 * A socket-free notes API for teardown: notes with comments under them, tags with no delete,
 * labels removed through an `x-cleanup` route, and lists that page by page number, offset or
 * cursor. Each tenant (`alpha`, `beta`) holds its own rows; the owner `root` may remove any.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const row = { properties: { id: { type: "string" } }, type: "object" }
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })
const tagged = (action: string, name: string) => ({ "x-entity": { action, identity: "id", name } })
const ok = (schema: unknown) => ({ "200": { description: "ok", ...json(schema) } })
const gone = { "204": { description: "gone" } }

/** How a list pages: by page number, by offset, by an envelope cursor, or not at all. */
export type Paging = "page" | "offset" | "cursor" | "none"

const PAGING_PARAMS: Record<Paging, unknown[]> = {
	cursor: [{ in: "query", name: "cursor", schema: { type: "string" } }],
	none: [],
	offset: [{ in: "query", name: "offset", schema: { type: "integer" } }],
	page: [{ in: "query", name: "page", schema: { minimum: 1, type: "integer" } }],
}

/* The notes list's envelope: a next cursor only where the list pages by cursor. */
const listed = (paging: Paging) => ({
	properties: {
		items: { items: row, type: "array" },
		...(paging === "cursor" ? { next_cursor: { type: "string" } } : {}),
	},
	type: "object",
})

/* Notes, and the comments under each. */
function notePaths(paging: Paging): Record<string, unknown> {
	const note = [param("note_id")]
	const comment = [param("note_id"), param("comment_id")]
	return {
		"/notes": {
			get: {
				operationId: "notes.list",
				parameters: PAGING_PARAMS[paging],
				responses: ok(listed(paging)),
				...tagged("list", "note"),
			},
			post: { operationId: "notes.create", responses: ok(row), ...tagged("create", "note") },
		},
		"/notes/{note_id}": {
			delete: { operationId: "notes.delete", parameters: note, responses: gone, ...tagged("delete", "note") },
			get: { operationId: "notes.get", parameters: note, responses: ok(row), ...tagged("read", "note") },
		},
		"/notes/{note_id}/comments": {
			get: {
				operationId: "comments.list",
				parameters: note,
				responses: ok({ items: row, type: "array" }),
				...tagged("list", "comment"),
			},
		},
		"/notes/{note_id}/comments/{comment_id}": {
			delete: { operationId: "comments.delete", parameters: comment, responses: gone, ...tagged("delete", "comment") },
			get: { operationId: "comments.get", parameters: comment, responses: ok(row), ...tagged("read", "comment") },
		},
	}
}

/* Labels, removed through an `x-cleanup` route, and tags, with no delete at all. */
const OTHER_PATHS = {
	"/admin/labels/{label_id}": {
		delete: { operationId: "labels.purge", parameters: [param("label_id")], responses: gone },
	},
	"/labels": {
		get: { operationId: "labels.list", responses: ok({ items: row, type: "array" }), ...tagged("list", "label") },
		post: {
			operationId: "labels.create",
			responses: ok(row),
			"x-cleanup": "DELETE /admin/labels/{label_id}",
			...tagged("create", "label"),
		},
	},
	"/tags": {
		get: { operationId: "tags.list", responses: ok({ items: row, type: "array" }), ...tagged("list", "tag") },
		post: { operationId: "tags.create", responses: ok(row), ...tagged("create", "tag") },
	},
}

/** The notes document, its notes list paging as `paging`. */
export function notesDoc(paging: Paging = "none", extra: Record<string, unknown> = {}): OpenApiDocument {
	return {
		info: { title: "notes", version: "1" },
		openapi: "3.1.0",
		paths: { ...OTHER_PATHS, ...notePaths(paging), ...extra },
	} as unknown as OpenApiDocument
}

export function notesModel(paging: Paging = "none", extra: Record<string, unknown> = {}): SpecModel {
	return modelOf(notesDoc(paging, extra))
}

/** A principal by name: a record it owns is removed as it. */
export function owner(id: string): Owner {
	return { id }
}

/** Where a disposable record was made and who made it. */
export interface Provenance {
	scope?: Record<string, string>
	by?: string
}

export function disposable(entity: string, id: string, { scope = {}, by = "alpha" }: Provenance = {}): Disposable {
	return { entity, id, owner: owner(by), scope }
}

/**
 * Who a request acts as, as the fake client hands it on: the principal, or "" for anyone else. The
 * API keys its tenants by principal, the way a real one keys them by the credential that principal sends.
 */
export function actorOf(options: object): string {
	const as = "as" in options ? options.as : undefined
	return typeof as === "object" && as !== null && "principal" in as ? String(as.principal) : ""
}

/** What the API holds, per tenant: note ids, and comment ids by note. */
export interface Store {
	notes: Map<string, string[]>
	/** A page of the list holds at most this many rows. */
	pageSize: number
	/** Answers that replace the API's own, by `METHOD /path`, each a fixed answer or one computed. */
	answers: Record<string, Answer | ((options: Omit<RequestOptions, "as">) => Answer)>
}

export function store(notes: Record<string, string[]> = {}, fields: Partial<Store> = {}): Store {
	return { answers: {}, notes: new Map(Object.entries(notes)), pageSize: 100, ...fields }
}

/** The notes API over `held`: a tenant reads and deletes only its own notes; `root` deletes any. */
export function notesApi(held: Store): Responder {
	return (method, path, options) => {
		const fixed = held.answers[`${method} ${path}`]
		if (fixed !== undefined) return typeof fixed === "function" ? fixed(options) : fixed
		const who = actorOf(options)
		if (method === "GET" && path === "/notes")
			return listPage(held.notes.get(who) ?? [], held.pageSize, options.query ?? {})
		const id = /^\/notes\/([^/]+)$/.exec(path)?.[1]
		if (id === undefined) return undefined
		const owning = who === "root" ? [...held.notes.keys()].find((tenant) => held.notes.get(tenant)?.includes(id)) : who
		const rows = held.notes.get(owning ?? "") ?? []
		if (!rows.includes(id)) return { status: 404 }
		if (method === "GET") return { body: { id }, status: 200 }
		held.notes.set(
			owning ?? "",
			rows.filter((each) => each !== id),
		)
		return { status: 204 }
	}
}

function listPage(rows: readonly string[], size: number, query: Record<string, unknown>): Answer {
	const start = query.page !== undefined ? (Number(query.page) - 1) * size : Number(query.offset ?? query.cursor ?? 0)
	const items = rows.slice(start, start + size).map((id) => ({ id }))
	const next = start + size < rows.length ? String(start + size) : ""
	return { body: { items, next_cursor: next }, status: 200 }
}

/** A fake client over the notes API. */
export function notesClient(held: Store) {
	return fakeClient(notesApi(held))
}

/** An unwind of `items` against `fields.model` over `held`, with every record still counted in place. */
export function unwindOf(
	held: Store,
	items: readonly Disposable[],
	fields: Pick<Unwind, "model"> & Partial<Unwind>,
): Unwind & { sent: ReturnType<typeof notesClient>["sent"] } {
	const { client, sent } = notesClient(held)
	return {
		client,
		deletedEarlier: () => false,
		done: 0,
		fallbacks: () => [],
		ledger: { movedAway: () => undefined, seenByCreator: () => true, sighted: () => undefined },
		onItem: undefined,
		paths: new Map(),
		records: new Map(
			items.map((item) => [item, { entity: item.entity, id: item.id, principal: item.owner.id, removed: false }]),
		),
		report: { failed: [], records: [], removed: 0, unidentified: [], unsupported: [] },
		sent,
		total: items.length,
		unsupported: new Set(),
		...fields,
	}
}
