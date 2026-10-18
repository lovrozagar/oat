import type { OpenApiDocument } from "../../../spec/types.ts"

/*
 * Small documents for seeding: notes under a project, with the create, list and read each
 * switchable and each create reshapable, and tables whose rows need a table made first.
 */

export const json = (schema: unknown): { content: Record<string, { schema: unknown }> } => ({
	content: { "application/json": { schema } },
})

const param = (name: string): Record<string, unknown> => ({
	in: "path",
	name,
	required: true,
	schema: { type: "string" },
})

export const NOTE = {
	properties: { id: { type: "string" }, name: { type: "string" }, size: { type: "integer" } },
	required: ["id", "name"],
	type: "object",
}

export interface NotesOptions {
	/** The create's request body schema; `null` for a create with no body. */
	body?: unknown
	/** Fields merged into the create operation: `x-unique`, `x-feature-gate`, `x-entity`, responses. */
	create?: Record<string, unknown>
	list?: boolean
	read?: boolean
	/** Fields merged into the read operation. */
	readOp?: Record<string, unknown>
	/** The read's path, when it names more than the note. */
	readPath?: string
}

export function notes(options: NotesOptions = {}): OpenApiDocument {
	const body = options.body === undefined ? NOTE : options.body
	const readPath = options.readPath ?? "/projects/{projectId}/notes/{noteId}"
	const readParams = [...readPath.matchAll(/\{([^}]+)\}/g)].map((match) => param(match[1] as string))
	return {
		info: { title: "notes", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/projects/{projectId}/notes": {
				...(options.list === false
					? {}
					: {
							get: {
								operationId: "note.list",
								parameters: [param("projectId")],
								responses: { "200": { ...json({ items: NOTE, type: "array" }), description: "ok" } },
							},
						}),
				post: {
					operationId: "note.create",
					parameters: [param("projectId")],
					...(body === null ? {} : { requestBody: { ...json(body), required: true } }),
					responses: { "200": { description: "acknowledged" } },
					...options.create,
				},
			},
			"/projects/{projectId}/notes/{noteId}": {
				delete: {
					operationId: "note.delete",
					parameters: [param("projectId"), param("noteId")],
					responses: { "204": { description: "gone" } },
				},
			},
			...(options.read === false
				? {}
				: {
						[readPath]: {
							get: {
								operationId: "note.get",
								parameters: readParams,
								responses: { "200": { ...json(NOTE), description: "ok" }, "404": { description: "missing" } },
								...options.readOp,
							},
						},
					}),
		},
	} as OpenApiDocument
}

const ITEM = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }

/** A record with no field oat can take for its identity. */
export const COUNTER = { properties: { flag: { type: "boolean" }, size: { type: "integer" } }, type: "object" }

/** An operation no entity owns. */
export const PAY: OpenApiDocument = {
	info: { title: "pay", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/pay": {
			post: { operationId: "pay.start", requestBody: json(COUNTER), responses: { "200": { description: "ok" } } },
		},
	},
} as OpenApiDocument

/** Counters have no identity of their own; ticks live under one. */
export const COUNTERS: OpenApiDocument = {
	info: { title: "counters", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/counters": {
			get: {
				operationId: "counter.list",
				responses: { "200": { ...json({ items: COUNTER, type: "array" }), description: "ok" } },
			},
			post: {
				operationId: "counter.create",
				requestBody: json(COUNTER),
				responses: { "201": { ...json(COUNTER), description: "ok" } },
			},
		},
		"/counters/{counter_id}/ticks": {
			get: {
				operationId: "tick.list",
				parameters: [param("counter_id")],
				responses: { "200": { ...json({ items: COUNTER, type: "array" }), description: "ok" } },
			},
			post: {
				operationId: "tick.create",
				parameters: [param("counter_id")],
				requestBody: json(COUNTER),
				responses: { "201": { description: "ok" } },
			},
		},
	},
} as OpenApiDocument

/** Notes under a tenant the path names but no entity models. */
export const TENANT: OpenApiDocument = {
	info: { title: "tenant", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/{tenant}/notes": {
			get: {
				operationId: "note.list",
				parameters: [param("tenant")],
				responses: { "200": { ...json({ items: COUNTER, type: "array" }), description: "ok" } },
			},
			post: {
				operationId: "note.create",
				parameters: [param("tenant")],
				requestBody: json(COUNTER),
				responses: { "201": { description: "ok" } },
			},
		},
	},
} as OpenApiDocument

/** Rows inside tables inside projects: a row's create needs a table, which oat makes first. */
export function tables(table: Record<string, unknown> | null = {}): OpenApiDocument {
	return {
		info: { title: "tables", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/projects/{project_id}/tables": {
				get: {
					operationId: "table.list",
					parameters: [param("project_id")],
					responses: { "200": { ...json({ items: ITEM, type: "array" }), description: "ok" } },
					"x-entity": { action: "list", name: "table" },
				},
				...(table === null
					? {}
					: {
							post: {
								operationId: "table.create",
								parameters: [param("project_id")],
								requestBody: {
									...json({ properties: { name: { type: "string" } }, required: ["name"], type: "object" }),
								},
								responses: { "201": { ...json(ITEM), description: "created" } },
								"x-entity": { action: "create", name: "table" },
								...table,
							},
						}),
			},
			"/projects/{project_id}/tables/{table_id}": {
				get: {
					operationId: "table.get",
					parameters: [param("project_id"), param("table_id")],
					responses: { "200": { ...json(ITEM), description: "ok" } },
					"x-entity": { action: "read", name: "table" },
				},
			},
			"/projects/{project_id}/tables/{table_id}/rows": {
				get: {
					operationId: "row.list",
					parameters: [param("project_id"), param("table_id")],
					responses: { "200": { ...json({ items: ITEM, type: "array" }), description: "ok" } },
					"x-entity": { action: "list", name: "row" },
				},
				post: {
					operationId: "row.create",
					parameters: [param("project_id"), param("table_id")],
					requestBody: { ...json({ properties: { name: { type: "string" } }, type: "object" }) },
					responses: { "201": { ...json(ITEM), description: "created" } },
					"x-entity": { action: "create", name: "row" },
				},
			},
		},
	} as unknown as OpenApiDocument
}
