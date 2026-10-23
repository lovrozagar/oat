import type { JsonSchema, OpenApiDocument } from "../../../../../spec/types.ts"
import type { RequestOptions } from "../../../../../client/types.ts"
import type { Record_ } from "../../../../world/records.ts"
import type { Answer, Responder } from "../../../__fixtures__/harness.ts"

/*
 * A small notes API for the consistency checks: a paged, sortable, projectable, filterable
 * collection of notes, a board collection and a stats singleton that a note create declares it
 * invalidates, and a route under an organisation whose identifier no note context holds.
 */

const note = {
	properties: {
		id: { type: "string" },
		status: { type: "string" },
		title: { type: "string" },
	},
	required: ["id", "title"],
	type: "object",
}

const board = { properties: { id: { type: "string" }, count: { type: "integer" } }, type: "object" }

const ok = (schema: unknown) => ({ "200": { content: { "application/json": { schema } }, description: "ok" } })

const param = (name: string, schema: JsonSchema = { type: "string" }) => ({ in: "query", name, schema })

const itemParam = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

/** Every query role the projections check reads through. */
export const FULL_LIST = [
	param("limit", { maximum: 5, type: "integer" }),
	param("page", { minimum: 1, type: "integer" }),
	param("sort"),
	param("fields"),
	param("status"),
	param("title"),
]

interface DocOptions {
	/** The note create's x-invalidate. */
	invalidate?: readonly string[]
	listParams?: readonly unknown[]
	/** False for a note create that takes no request body. */
	createBody?: boolean
}

/** The paths of the notes API. */
function paths(options: DocOptions): Record<string, unknown> {
	const body = { content: { "application/json": { schema: note } }, required: true }
	return {
		"/boards": {
			get: { operationId: "boards.list", responses: ok({ items: board, type: "array" }) },
			post: { operationId: "boards.create", responses: ok(board) },
		},
		"/boards/{board_id}": {
			get: { operationId: "boards.get", parameters: [itemParam("board_id")], responses: ok(board) },
		},
		"/notes": {
			get: {
				operationId: "notes.list",
				parameters: options.listParams ?? FULL_LIST,
				responses: ok({ items: note, type: "array" }),
			},
			post: {
				operationId: "notes.create",
				...(options.createBody === false ? {} : { requestBody: body }),
				responses: { "201": { content: { "application/json": { schema: note } }, description: "made" } },
				"x-invalidate": options.invalidate ?? [],
			},
		},
		"/notes/{note_id}": {
			get: { operationId: "notes.get", parameters: [itemParam("note_id")], responses: ok(note) },
		},
		"/orgs/{org_id}/summary": {
			get: { operationId: "summary.get", parameters: [itemParam("org_id")], responses: ok(board) },
		},
		"/stats": { get: { operationId: "stats.get", responses: ok(board) } },
	}
}

/** The notes document. */
export function notesDoc(options: DocOptions = {}): OpenApiDocument {
	return {
		info: { title: "notes", version: "1" },
		openapi: "3.1.0",
		paths: paths(options),
	} as unknown as OpenApiDocument
}

/** One page of `rows` as a correct backend serves it: equality filters, sort, page, projection. */
export function servePage(rows: readonly Record_[], query: NonNullable<RequestOptions["query"]> = {}): Record_[] {
	const filtered = rows.filter((row) =>
		["status", "title"].every((field) => query[field] === undefined || String(row[field]) === String(query[field])),
	)
	const order = typeof query.sort === "string" ? query.sort.replace(/\.asc$/, "") : undefined
	const sorted =
		order === undefined ? filtered : filtered.toSorted((a, b) => String(a[order]).localeCompare(String(b[order])))
	const limit = Number(query.limit ?? 100)
	const page = Number(query.page ?? 1)
	const window = sorted.slice((page - 1) * limit, page * limit)
	if (typeof query.fields !== "string") return window
	const keep = query.fields.split(",")
	return window.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => keep.includes(key))))
}

/**
 * A correct notes backend over `rows`: lists, reads by id, and creates under the next id. Any
 * route it does not know answers 404.
 */
export function notesBackend(rows: Record_[]): Responder {
	return (method, path, options): Answer | undefined => {
		if (method === "GET" && path === "/notes") return { body: servePage(rows, options.query), status: 200 }
		const item = /^\/notes\/([^/]+)$/.exec(path)
		if (method === "GET" && item !== null) {
			const found = rows.find((row) => row.id === item[1])
			return found === undefined ? undefined : { body: found, status: 200 }
		}
		if (method === "POST" && path === "/notes") {
			const made = { ...(options.body as Record_), id: `n${rows.length + 1}` }
			rows.push(made)
			return { body: made, status: 201 }
		}
		return undefined
	}
}
