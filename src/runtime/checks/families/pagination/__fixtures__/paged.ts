import type { RequestOptions } from "../../../../../client/types.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import type { Record_ } from "../../../../world/records.ts"
import { type Answer, contextFor, modelOf, op, type Responder } from "../../../__fixtures__/harness.ts"
import type { CheckContext } from "../../../core/context.ts"

/*
 * A list endpoint for the pagination checks: a document whose query parameters and envelope a
 * test picks, and an in-memory collection that pages it correctly. A test that needs a defect
 * starts from the correct page and changes the one thing the defect changes.
 */

const ITEM = {
	properties: { id: { type: "string" }, name: { type: "string" }, tag: { type: "string" } },
	type: "object",
}

const PARAM_SCHEMA: Record<string, Record<string, unknown>> = {
	cursor: { type: "string" },
	filter: { type: "string" },
	limit: { type: "integer" },
	offset: { type: "integer" },
	page: { type: "integer" },
	sort: { type: "string" },
}

const ENVELOPE_SCHEMA: Record<string, Record<string, unknown>> = {
	hasMore: { type: "boolean" },
	nextCursor: { type: ["string", "null"] },
	total: { type: "integer" },
}

export interface ListDoc {
	/** Query parameters by role name: limit, page, offset, cursor, sort, filter. */
	params: string[]
	/** Envelope keys beside `items`; `null` makes the body a bare array. */
	envelope?: string[] | null
	/** The page-size parameter's schema maximum. */
	limitMax?: number
	"x-query"?: Record<string, unknown>
	/** Response headers the 200 declares, such as `Link`. */
	headers?: string[]
}

export function listDoc(spec: ListDoc): OpenApiDocument {
	const envelope = spec.envelope === undefined ? [] : spec.envelope
	const schema =
		envelope === null
			? { items: ITEM, type: "array" }
			: {
					properties: {
						items: { items: ITEM, type: "array" },
						...Object.fromEntries(envelope.map((key) => [key, ENVELOPE_SCHEMA[key]])),
					},
					type: "object",
				}
	const parameters = spec.params.map((name) => ({
		in: "query",
		name,
		schema:
			name === "limit" && spec.limitMax !== undefined
				? { maximum: spec.limitMax, type: "integer" }
				: PARAM_SCHEMA[name],
	}))
	const headers = Object.fromEntries((spec.headers ?? []).map((name) => [name, { schema: { type: "string" } }]))
	return {
		info: { title: "widgets", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/widgets": {
				get: {
					operationId: "listWidgets",
					parameters,
					responses: { "200": { content: { "application/json": { schema } }, description: "ok", headers } },
					...(spec["x-query"] === undefined ? {} : { "x-query": spec["x-query"] }),
				},
			},
		},
	} as unknown as OpenApiDocument
}

/** `n` widgets: ids w01.., names in id order, tags repeating every `tags`. */
export function widgets(n: number, tags = 2): Record_[] {
	return Array.from({ length: n }, (_, i) => {
		const id = `w${String(i + 1).padStart(2, "0")}`
		return { id, name: `name-${id}`, tag: `t${i % tags}` }
	})
}

/** The query as the client sent it. */
export function queryOf(options: RequestOptions): Record<string, unknown> {
	return (options.query ?? {}) as Record<string, unknown>
}

/** The field a sort term names, whatever direction marks it. */
function sortField(term: unknown): string | undefined {
	return typeof term === "string" ? /^[-+]?([A-Za-z_]+)/.exec(term)?.[1] : undefined
}

/** One correct page of `rows` for `query`, as the envelope reports it. */
export function page(
	rows: Record_[],
	query: Record<string, unknown>,
): { items: Record_[]; total: number; hasMore: boolean; nextCursor: string | null } {
	const field = sortField(query.sort)
	const ordered = field === undefined ? rows : rows.toSorted((a, b) => String(a[field]).localeCompare(String(b[field])))
	const size = typeof query.limit === "number" ? query.limit : 100
	const start =
		typeof query.cursor === "string"
			? Number(query.cursor)
			: typeof query.page === "number"
				? (query.page - 1) * size
				: typeof query.offset === "number"
					? query.offset
					: 0
	const items = ordered.slice(start, start + size)
	const end = start + items.length
	const hasMore = end < ordered.length
	return { hasMore, items, nextCursor: hasMore ? String(end) : null, total: ordered.length }
}

/** A correct backend over `rows`; `edit` changes one page before it is served. */
export function pagedBackend(
	rows: Record_[],
	edit: (body: ReturnType<typeof page>, query: Record<string, unknown>) => Answer | undefined = (body) => ({
		body,
		status: 200,
	}),
): Responder {
	return (_method, _path, options) => {
		const query = queryOf(options)
		return edit(page(rows, query), query)
	}
}

/** A context over `doc`'s list endpoint, with the endpoint's query capability and `records`. */
export function stage(doc: OpenApiDocument, respond: Responder, records: Record_[]) {
	const model = modelOf(doc)
	const listOp = op(model, "listWidgets")
	const fields: Partial<CheckContext> = {
		collectionKey: listOp.collection?.key ?? null,
		query: listOp.query,
		records,
	}
	return contextFor(model, "listWidgets", respond, fields)
}
