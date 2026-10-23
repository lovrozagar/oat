import type { RequestOptions } from "../../../../../client/types.ts"
import type {
	HttpMethod,
	JsonSchema,
	MediaTypeObject,
	OpenApiDocument,
	OperationObject,
	ParameterObject,
} from "../../../../../spec/types.ts"
import type { Answer, Responder } from "../../../__fixtures__/harness.ts"

/*
 * A small widget collection for the write checks' tests: a document whose operations a test turns
 * on and off, and an in-memory backend that behaves correctly unless a test answers first.
 */

export interface WidgetDocOptions {
	/** The request and response schema of one widget. */
	item?: JsonSchema
	/** The update method, or none. */
	update?: "patch" | "put" | null
	read?: boolean
	remove?: boolean
	/** Parameters of the create operation, such as an idempotency-key header. */
	createParameters?: unknown[]
	/** The create's documented success status. */
	createStatus?: string
}

/** A writable widget: a server-issued id and three free strings, one nullable. */
export const WIDGET: JsonSchema = {
	properties: {
		id: { readOnly: true, type: "string" },
		label: { maxLength: 200, type: "string" },
		name: { type: "string" },
		note: { maxLength: 400, type: ["string", "null"] },
	},
	required: ["name"],
	type: "object",
}

function json(schema: JsonSchema): { content: Record<string, MediaTypeObject> } {
	return { content: { "application/json": { schema } } }
}

type ItemRoute = Partial<Record<HttpMethod, OperationObject>> & { parameters: ParameterObject[] }

function itemRoute(options: WidgetDocOptions, item: JsonSchema): ItemRoute {
	const route: ItemRoute = { parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }] }
	if (options.read !== false) {
		route.get = { operationId: "getWidget", responses: { "200": { description: "ok", ...json(item) } } }
	}
	const update = options.update === undefined ? "patch" : options.update
	if (update !== null) {
		route[update] = {
			operationId: "updateWidget",
			requestBody: json(item),
			responses: { "200": { description: "ok", ...json(item) } },
		}
	}
	if (options.remove !== false)
		route.delete = { operationId: "deleteWidget", responses: { "204": { description: "ok" } } }
	return route
}

export function widgetDoc(options: WidgetDocOptions = {}): OpenApiDocument {
	const item = options.item ?? WIDGET
	return {
		info: { title: "widgets", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/widgets": {
				get: {
					operationId: "listWidgets",
					responses: { "200": { description: "ok", ...json({ items: item, type: "array" }) } },
				},
				post: {
					operationId: "createWidget",
					parameters: options.createParameters ?? [],
					requestBody: json(item),
					responses: { [options.createStatus ?? "201"]: { description: "ok", ...json(item) } },
				},
			},
			"/widgets/{id}": itemRoute(options, item),
		},
	} as unknown as OpenApiDocument
}

/** The backend's rows, by id, in insertion order. */
export type Rows = Map<string, Record<string, unknown>>

/** The request body as a record; anything else (text, a list) is an empty one. */
function bodyOf(options: Omit<RequestOptions, "as">): Record<string, unknown> {
	const body = options.body
	return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

/** A request to one item: its method, the id its path names, and how it was sent. */
interface ItemRequest {
	method: string
	id: string
	options: Omit<RequestOptions, "as">
}

function itemAnswer(rows: Rows, { method, id, options }: ItemRequest): Answer | undefined {
	const row = rows.get(id)
	if (row === undefined) return undefined
	if (method === "GET") return { body: row, status: 200 }
	if (method === "DELETE") {
		rows.delete(id)
		return { status: 204 }
	}
	const next = method === "PUT" ? { ...bodyOf(options), id } : { ...row, ...bodyOf(options), id }
	rows.set(id, next)
	return { body: next, status: 200 }
}

/** A correct widget backend over `rows`: ids are the client's when sent, `w1`, `w2`, … otherwise. */
export function widgetApi(rows: Rows = new Map()): Responder {
	let issued = 0
	return (method, path, options) => {
		if (path === "/widgets") {
			if (method === "GET") return { body: [...rows.values()], status: 200 }
			const body = bodyOf(options)
			issued += 1
			const id = typeof body.id === "string" || typeof body.id === "number" ? String(body.id) : `w${issued}`
			const row = { ...body, id }
			rows.set(id, row)
			return { body: row, status: 201 }
		}
		const id = decodeURIComponent(path.slice("/widgets/".length))
		return itemAnswer(rows, { id, method, options })
	}
}

/** `answer` first; whatever it leaves `undefined` falls through to `backend`. */
export function overriding(backend: Responder, answer: Responder): Responder {
	return (method, path, options) => answer(method, path, options) ?? backend(method, path, options)
}
