import type { RequestOptions } from "../../../../../client/types.ts"
import type { FindingCollector } from "../../../../finding.ts"
import type { SpecModel } from "../../../../../spec/graph.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import { type Answer, contextFor, modelOf, op, type Responder, type Sent } from "../../../__fixtures__/harness.ts"
import type { CheckContext, WriteContext } from "../../../core/context.ts"

/*
 * A notes API for the write checks: list, create, read, update and delete on one entity, every
 * operation behind a feature gate that only a 403 naming it trips. `notesServer` stores records
 * in memory and answers like a correct backend; a test overrides one route to play a defect.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const idParam = (schema: unknown = { type: "string" }) => ({ in: "path", name: "id", required: true, schema })
const GATE = { "x-feature-gate": "notes" }
const entity = (action: string) => ({ "x-entity": { action, name: "note" } })

/** The stored representation: `id` and `created_at` are the server's. */
export const NOTE = {
	properties: {
		code: { type: "string" },
		created_at: { readOnly: true, type: "string" },
		id: { readOnly: true, type: "string" },
		name: { type: "string" },
		size: { type: "integer" },
		title: { type: "string" },
	},
	type: "object",
}

/** What a create or an update takes. */
export const NOTE_INPUT = {
	properties: {
		code: { type: "string" },
		name: { type: "string" },
		size: { type: "integer" },
		title: { type: "string" },
	},
	required: ["name"],
	type: "object",
}

export interface NotesOptions {
	/** The update's method; PATCH unless a test needs PUT. */
	updateMethod?: "patch" | "put"
	/** The create's request media type. */
	createMedia?: string
	/** `x-unique` on create and update. */
	unique?: string[][]
	/** `x-immutable` on the update. */
	immutable?: string[]
	/** `x-soft-delete` on the delete. */
	softDelete?: string
	/** Leave the request body off the create. */
	createWithoutBody?: boolean
	/** The item route's identifier schema. */
	idSchema?: Record<string, unknown>
	/** `x-generated` on the create and on the update. */
	generated?: { create?: string[]; update?: string[] }
}

function itemRoutes(options: NotesOptions): Record<string, unknown> {
	const update = options.updateMethod ?? "patch"
	const ID = idParam(options.idSchema)
	return {
		delete: {
			operationId: "note.delete",
			parameters: [ID],
			responses: { "204": { description: "gone" } },
			...entity("delete"),
			...GATE,
			...(options.softDelete === undefined ? {} : { "x-soft-delete": options.softDelete }),
		},
		get: {
			operationId: "note.get",
			parameters: [ID],
			responses: { "200": { ...json(NOTE), description: "ok" } },
			...entity("read"),
			...GATE,
		},
		[update]: {
			operationId: "note.update",
			parameters: [ID],
			requestBody: { ...json(NOTE_INPUT), required: true },
			responses: { "200": { ...json(NOTE), description: "ok" } },
			...entity("update"),
			...GATE,
			...(options.unique === undefined ? {} : { "x-unique": options.unique }),
			...(options.immutable === undefined ? {} : { "x-immutable": options.immutable }),
			...(options.generated?.update === undefined ? {} : { "x-generated": options.generated.update }),
		},
	}
}

/** The notes document, with the tags a test asks for. */
export function notesDocument(options: NotesOptions = {}): OpenApiDocument {
	const media = options.createMedia ?? "application/json"
	const body =
		options.createWithoutBody === true ? {} : { requestBody: { content: { [media]: { schema: NOTE_INPUT } } } }
	return {
		info: { title: "notes", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "note.list",
					responses: { "200": { ...json({ items: NOTE, type: "array" }), description: "ok" } },
					...entity("list"),
					...GATE,
				},
				post: {
					operationId: "note.create",
					...body,
					responses: { "201": { ...json(NOTE), description: "created" } },
					...entity("create"),
					...GATE,
					...(options.unique === undefined ? {} : { "x-unique": options.unique }),
					...(options.generated?.create === undefined ? {} : { "x-generated": options.generated.create }),
				},
			},
			"/notes/{id}": itemRoutes(options),
		},
	} as unknown as OpenApiDocument
}

export type Note = Record<string, unknown>

/** An in-memory notes backend that behaves; `records` is what it holds. */
export interface NotesServer {
	records: Map<string, Note>
	respond: Responder
}

/* A form or multipart body as the client hands it over, read back as fields. */
function fieldsOf(options: RequestOptions): Note {
	const body = options.body
	if (body instanceof URLSearchParams) return Object.fromEntries(body.entries())
	if (body !== null && typeof body === "object") return body as Note
	return {}
}

function writeRoute(server: NotesServer, method: string, id: string, options: RequestOptions): Answer {
	const current = server.records.get(id)
	if (current === undefined) return { status: 404 }
	if (method === "DELETE") {
		server.records.delete(id)
		return { status: 204 }
	}
	const next =
		method === "PUT"
			? { ...fieldsOf(options), created_at: current.created_at, id }
			: { ...current, ...fieldsOf(options) }
	server.records.set(id, next)
	return { body: { ...next }, status: 200 }
}

/**
 * A correct notes backend: creates echo the record, reads find it, deletes remove it. Every answer
 * is a copy, as a serialized body would be, so a later change to the store never rewrites it.
 */
export function notesServer(seed: Note[] = []): NotesServer {
	let made = 0
	const server: NotesServer = {
		records: new Map(seed.map((note) => [String(note.id), note])),
		respond: () => undefined,
	}
	server.respond = (method, path, options) => {
		if (path === "/notes" && method === "GET") {
			return { body: [...server.records.values()].map((note) => ({ ...note })), status: 200 }
		}
		if (path === "/notes" && method === "POST") {
			made += 1
			const record = { ...fieldsOf(options), created_at: "2026-01-01", id: `n${made}` }
			server.records.set(record.id, record)
			return { body: { ...record }, status: 201 }
		}
		const id = path.startsWith("/notes/") ? decodeURIComponent(path.slice("/notes/".length)) : undefined
		if (id === undefined) return undefined
		if (method === "GET") {
			const found = server.records.get(id)
			return found === undefined ? { status: 404 } : { body: { ...found }, status: 200 }
		}
		return writeRoute(server, method, id, options)
	}
	return server
}

/** A documented feature-gate refusal. */
export const GATED: Answer = { body: { vars: { feature: "notes", type: "feature_gate" } }, status: 403 }

/** A model of the notes document. */
export function notesModel(options: NotesOptions = {}): SpecModel {
	return modelOf(notesDocument(options))
}

/** A context on the notes entity with every operation it declares wired in. */
export function notesContext(
	model: SpecModel,
	respond: Responder,
	fields: Partial<CheckContext> = {},
): { ctx: WriteContext; sent: Sent[]; findings: FindingCollector } {
	return contextFor(model, "note.list", respond, {
		createOp: op(model, "note.create"),
		deleteOp: op(model, "note.delete"),
		readOp: op(model, "note.get"),
		updateOp: op(model, "note.update"),
		...fields,
	})
}
