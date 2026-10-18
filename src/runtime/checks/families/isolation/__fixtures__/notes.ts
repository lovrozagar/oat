import type { OpenApiDocument } from "../../../../../spec/types.ts"

/*
 * A tenant-scoped notes collection: list and create under `/orgs/{org_id}/notes`, read, patch
 * and delete one note under it. Options add what one isolation check needs and nothing more.
 */

export interface NotesOptions {
	/** `x-tenant` on every operation: a parameter name, `false` for none, or absent to infer. */
	tenant?: string | false
	/** Path prefix in place of `/orgs/{org_id}`. */
	root?: string
	/** Leave out these operations. */
	without?: ReadonlyArray<"createNote" | "readNote" | "updateNote" | "deleteNote">
	/** Method of the update operation. */
	updateMethod?: "patch" | "put"
	/** A filter declaration on the list (`x-query`). */
	query?: Record<string, unknown>
	/** Extra operations by path. */
	extraPaths?: Record<string, Record<string, unknown>>
	/** Extensions put on the list operation. */
	listExtensions?: Record<string, unknown>
	/** Query parameters the list takes. */
	listQuery?: ReadonlyArray<Record<string, unknown>>
	/** A create that takes no request body. */
	bodilessCreate?: boolean
	/** Schema of the `note_id` path parameter. */
	idSchema?: Record<string, unknown>
}

const NOTE = {
	properties: {
		body: { type: "string" },
		id: { readOnly: true, type: "string" },
		title: { type: "string" },
	},
	required: ["title"],
	type: "object",
}

const NOTE_INPUT = {
	properties: { body: { type: "string" }, title: { type: "string" } },
	required: ["title"],
	type: "object",
}

function json(schema: unknown): Record<string, unknown> {
	return { content: { "application/json": { schema } } }
}

function paramsOf(
	path: string,
	idSchema: Record<string, unknown> = { type: "string" },
): Array<Record<string, unknown>> {
	return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
		in: "path",
		name: match[1],
		required: true,
		schema: match[1] === "note_id" ? idSchema : { type: "string" },
	}))
}

export function notesDocument(options: NotesOptions = {}): OpenApiDocument {
	const root = options.root ?? "/orgs/{org_id}"
	const tenant = options.tenant === undefined ? {} : { "x-tenant": options.tenant }
	const without = new Set(options.without ?? [])
	const list = `${root}/notes`
	const item = `${list}/{note_id}`
	const keep = (id: string, operation: Record<string, unknown>): Record<string, unknown> =>
		without.has(id as never) ? {} : operation
	const collection: Record<string, unknown> = {
		get: {
			operationId: "listNotes",
			parameters: [...paramsOf(list), ...(options.listQuery ?? [])],
			responses: { "200": { description: "notes", ...json({ items: NOTE, type: "array" }) } },
			...tenant,
			...(options.query === undefined ? {} : { "x-query": options.query }),
			...options.listExtensions,
		},
		...keep("createNote", {
			post: {
				operationId: "createNote",
				parameters: paramsOf(list),
				...(options.bodilessCreate === true ? {} : { requestBody: { required: true, ...json(NOTE_INPUT) } }),
				responses: { "201": { description: "made", ...json(NOTE) } },
				...tenant,
			},
		}),
	}
	const single: Record<string, unknown> = {
		...keep("readNote", {
			get: {
				operationId: "readNote",
				parameters: paramsOf(item, options.idSchema),
				responses: { "200": { description: "one", ...json(NOTE) }, "404": { description: "none" } },
				...tenant,
			},
		}),
		...keep("updateNote", {
			[options.updateMethod ?? "patch"]: {
				operationId: "updateNote",
				parameters: paramsOf(item, options.idSchema),
				requestBody: { required: true, ...json(NOTE_INPUT) },
				responses: { "200": { description: "changed", ...json(NOTE) } },
				...tenant,
			},
		}),
		...keep("deleteNote", {
			delete: {
				operationId: "deleteNote",
				parameters: paramsOf(item, options.idSchema),
				responses: { "204": { description: "gone" } },
				...tenant,
			},
		}),
	}
	return {
		info: { title: "notes", version: "1" },
		openapi: "3.1.0",
		paths: { [list]: collection, [item]: single, ...options.extraPaths },
	} as OpenApiDocument
}
