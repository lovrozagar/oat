import type { RequestOptions } from "../../../../../client/types.ts"
import type { Outcome } from "../../../../finding.ts"
import type { Record_ } from "../../../../world.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import { type Answer, contextFor, modelOf, op, type Responder } from "../../../__fixtures__/harness.ts"
import type { Check } from "../../../core/check.ts"
import type { CheckContext } from "../../../core/context.ts"
import { runCheck } from "../../../core/run.ts"

/*
 * A notes listing for the query families: a document with filter, order, select and search
 * parameters, a seeded cohort, and an in-memory backend that answers them correctly. A test
 * stages a check against it and wraps the backend to plant the one defect the check exists for.
 */

/** The listing's path and operation. */
export const PATH = "/v1/notes"
export const LIST = "note.list"

/** The seeded cohort: ties on status and rank, a nullable score, mixed-case multi-word titles. */
export const NOTES: readonly Record_[] = [
	{
		author: { email: "ann@x.test", name: "Ann" },
		id: "n1",
		rank: 10,
		score: null,
		status: "open",
		title: "Alpha report",
	},
	{ author: { email: "bo@x.test", name: "Bo" }, id: "n2", rank: 2, score: 5, status: "open", title: "Beta report" },
	{ author: null, id: "n3", rank: 33, score: 1, status: "closed", title: "Alpha memo" },
	{ author: { email: "cy@x.test", name: "Cy" }, id: "n4", rank: 9, score: null, status: "open", title: "Gamma memo" },
	{ author: { email: "di@x.test", name: "Di" }, id: "n5", rank: 2, score: 3, status: "closed", title: "Delta note" },
	{ author: { email: "ed@x.test", name: "Ed" }, id: "n6", rank: 100, score: 7, status: "archived", title: "beta note" },
]

/** The query parameters the document declares by default; `page` is added for paged listings. */
export const PARAMS = ["filter", "order", "select", "q", "search_mode", "limit"] as const

/** The `x-query` tag every document starts from. */
export const X_QUERY: Readonly<Record<string, unknown>> = {
	filterable: ["title", "status", "rank"],
	grammar: "postgrest",
	searchable: ["title"],
	selectable: ["id", "title", "status", "rank", "score", "author"],
	sortable: ["title", "status", "rank", "score"],
}

const ITEM = {
	properties: {
		author: {
			oneOf: [
				{ properties: { email: { type: "string" }, name: { type: "string" } }, type: "object" },
				{ type: "null" },
			],
		},
		id: { type: "string" },
		rank: { type: "integer" },
		score: { oneOf: [{ type: "integer" }, { type: "null" }] },
		status: { type: "string" },
		title: { type: "string" },
	},
	required: ["id"],
	type: "object",
}

/* A page size up to 50, and a page number with no maximum: what makes oat read it as one. */
const SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
	limit: { maximum: 50, minimum: 1, type: "integer" },
	page: { minimum: 1, type: "integer" },
}

/** The notes document: `xQuery` is merged over the default tag, `params` replaces the parameter list. */
export function queryDoc(xQuery: Record<string, unknown> = {}, params: readonly string[] = PARAMS): OpenApiDocument {
	const parameters = params.map((name) => ({
		in: "query",
		name,
		schema: SCHEMAS[name] ?? { type: "string" },
	}))
	return {
		info: { title: "notes", version: "1" },
		openapi: "3.1.0",
		paths: {
			[PATH]: {
				get: {
					operationId: LIST,
					parameters,
					responses: {
						"200": {
							content: { "application/json": { schema: { items: ITEM, type: "array" } } },
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "note" },
					"x-query": { ...X_QUERY, ...xQuery },
				},
			},
		},
	} as unknown as OpenApiDocument
}

/** A rejection as the backend sends it. */
export const REJECT: Answer = { body: { error: "bad query" }, status: 400 }

/** The query a request carried, as strings. */
export function queryOf(options: RequestOptions): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) out[key] = String(value)
	return out
}

function matchesTerm(row: Record_, term: string): boolean | null {
	const [field = "", operator = "", ...rest] = term.split(".")
	const value = rest.join(".")
	if (!(field in ITEM.properties)) return null
	const held = String(row[field])
	if (operator === "eq") return held === value
	if (operator === "neq") return held !== value
	return null
}

/** Rows a postgrest filter keeps — `field.eq.value` or `and(a,b)` — or null for one it cannot read. */
export function applyFilter(rows: readonly Record_[], filter: string): Record_[] | null {
	const terms = filter.startsWith("and(") && filter.endsWith(")") ? filter.slice(4, -1).split(",") : [filter]
	const kept: Record_[] = []
	for (const row of rows) {
		const verdicts = terms.map((term) => matchesTerm(row, term))
		if (verdicts.includes(null)) return null
		if (verdicts.every(Boolean)) kept.push(row)
	}
	return kept
}

/** Rows holding every whitespace-separated token in a searchable field, case-insensitively. */
export function applySearch(
	rows: readonly Record_[],
	search: string,
	fields: readonly string[] = ["title"],
): Record_[] {
	const tokens = search.toLowerCase().split(/\s+/).filter(Boolean)
	return rows.filter((row) =>
		tokens.every((token) =>
			fields.some((field) =>
				String(row[field] ?? "")
					.toLowerCase()
					.includes(token),
			),
		),
	)
}

interface OrderKey {
	field: string
	sign: 1 | -1
	nullsFirst: boolean
}

function parseOrder(order: string): OrderKey[] | null {
	const keys: OrderKey[] = []
	for (const part of order.split(",")) {
		const [field = "", direction = "asc", nulls] = part.split(".")
		if (!(field in ITEM.properties) || (direction !== "asc" && direction !== "desc")) return null
		if (nulls !== undefined && nulls !== "nullsfirst" && nulls !== "nullslast") return null
		const sign = direction === "asc" ? 1 : -1
		keys.push({ field, nullsFirst: nulls === undefined ? sign === -1 : nulls === "nullsfirst", sign })
	}
	return keys
}

function compareKey(a: Record_, b: Record_, key: OrderKey): number {
	const x = a[key.field]
	const y = b[key.field]
	const xNull = x === null || x === undefined
	const yNull = y === null || y === undefined
	if (xNull || yNull) return xNull === yNull ? 0 : (xNull ? -1 : 1) * (key.nullsFirst ? 1 : -1)
	if (typeof x === "number" && typeof y === "number") return (x - y) * key.sign
	return (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0) * key.sign
}

/** Rows ordered by a postgrest order (`a.asc,b.desc.nullslast`), ties by position; null when unreadable. */
export function applyOrder(rows: readonly Record_[], order: string): Record_[] | null {
	const keys = parseOrder(order)
	if (keys === null) return null
	return rows.toSorted((a, b) => {
		for (const key of keys) {
			const result = compareKey(a, b, key)
			if (result !== 0) return result
		}
		return 0
	})
}

function project(row: Record_, names: readonly string[]): Record_ {
	const out: Record_ = {}
	for (const name of names) {
		const nested = /^(\w+)\((.+)\)$/.exec(name)
		if (nested === null) {
			if (name in row) out[name] = row[name]
			continue
		}
		const [, relation = "", inner = ""] = nested
		const related = row[relation] as Record_ | null | undefined
		out[relation] = related === null || related === undefined ? null : project(related, inner.split(","))
	}
	return out
}

/** Rows cut to a csv sparse fieldset (`id,author(name)`); null when it names an unknown field. */
export function applySelect(rows: readonly Record_[], select: string): Record_[] | null {
	const names = select.match(/\w+\([^)]*\)|[^,]+/g) ?? []
	if (names.some((name) => !(name.replace(/\(.*$/, "") in ITEM.properties))) return null
	return rows.map((row) => project(row, names))
}

/** Options for the in-memory backend. */
export interface BackendOptions {
	/** Parameter names the backend accepts; any other is refused. Default: the document's. */
	params?: readonly string[]
}

function window(rows: readonly Record_[], query: Record<string, string>): Record_[] {
	const limit = query.limit === undefined ? rows.length : Number(query.limit)
	const start = query.page === undefined ? 0 : (Number(query.page) - 1) * limit
	return rows.slice(start, start + limit)
}

/** The listing as a correct backend answers it, or a 400 for a query it cannot read. */
export function answer(rows: readonly Record_[], query: Record<string, string>, accepted: readonly string[]): Answer {
	if (Object.keys(query).some((key) => !accepted.includes(key))) return REJECT
	let result: Record_[] | null = [...rows]
	if (query.filter !== undefined) result = applyFilter(result, query.filter)
	if (result !== null && query.q !== undefined) result = applySearch(result, query.q)
	if (result !== null && query.order !== undefined) result = applyOrder(result, query.order)
	if (result === null) return REJECT
	result = window(result, query)
	if (query.select !== undefined) result = applySelect(result, query.select)
	return result === null ? REJECT : { body: result, status: 200 }
}

/** A correct backend over `rows`: GET on the listing answers the query; anything else is a 404. */
export function backend(rows: readonly Record_[] = NOTES, options: BackendOptions = {}): Responder {
	const accepted = options.params ?? [...PARAMS, "page"]
	return (method, path, request) =>
		method === "GET" && path === PATH ? answer(rows, queryOf(request), accepted) : undefined
}

/** What a staged check needs: its document, cohort, backend and any context fields to override. */
export interface StageOptions {
	doc?: OpenApiDocument
	rows?: readonly Record_[]
	respond?: Responder
	fields?: Partial<CheckContext>
}

/** One check staged against the notes listing: its context, findings and the requests it sent. */
export function stage(check: Check, options: StageOptions = {}) {
	const model = modelOf(options.doc ?? queryDoc())
	const rows = options.rows ?? NOTES
	const staged = contextFor(model, LIST, options.respond ?? backend(rows), {
		query: op(model, LIST).query,
		records: rows.map((row) => ({ ...row })),
		...options.fields,
	})
	return {
		...staged,
		plan: () => check.plan(staged.ctx),
		run: (): Promise<Outcome> => runCheck(check, staged.ctx),
	}
}
