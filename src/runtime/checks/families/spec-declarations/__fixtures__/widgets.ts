import type { QueryConventions } from "../../../../../spec/conventions/types.ts"
import type { QueryCapability } from "../../../../../spec/extensions/query-tag.ts"
import type { OperationModel, SpecModel } from "../../../../../spec/graph/types.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import type { CheckContext } from "../../../core/context.ts"
import { contextFor, modelOf, op, type Responder, type Sent } from "../../../__fixtures__/harness.ts"

/*
 * One listed entity with every query role the declaration checks probe: a filter expression in
 * the PostgREST grammar, an order parameter, a sparse fieldset and a page size. The list and the
 * create operation carry a declared rate limit; the read carries none.
 */

const item = {
	properties: {
		active: { type: "boolean" },
		id: { readOnly: true, type: "string" },
		/* No string meets it, so no sentinel can be drawn for it or for a list of it. */
		impossible: { maxLength: 1, minLength: 5, type: "string" },
		impossibles: { items: { maxLength: 1, minLength: 5, type: "string" }, type: "array" },
		meta: { type: "object" },
		name: { type: "string" },
		price: { type: "number" },
		tags: { items: { type: "string" }, type: "array" },
	},
	required: ["name"],
	type: "object",
}

const json = (schema: unknown) => ({ content: { "application/json": { schema } }, description: "ok" })

/** The widgets document; `query` replaces the list's query parameters when a test needs fewer roles. */
export function widgetsDocument(query?: Array<Record<string, unknown>>): OpenApiDocument {
	return {
		info: { title: "widgets", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/widgets": {
				get: {
					operationId: "listWidgets",
					parameters: query ?? [
						{ in: "query", name: "filter", schema: { type: "string" } },
						{ in: "query", name: "order", schema: { type: "string" } },
						{ in: "query", name: "select", schema: { type: "string" } },
						{ in: "query", name: "limit", schema: { maximum: 100, type: "integer" } },
					],
					responses: { "200": json({ items: item, type: "array" }) },
					"x-query": { grammar: "postgrest", sortGrammar: "dotted" },
					"x-rate-limit": { category: "reads", rps: 5 },
				},
				post: {
					operationId: "createWidget",
					requestBody: { content: { "application/json": { schema: item } } },
					responses: { "201": json(item) },
					"x-rate-limit": { category: "writes" },
				},
			},
			"/widgets/{id}": {
				get: {
					operationId: "getWidget",
					parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
					responses: { "200": json(item) },
				},
			},
		},
	} as unknown as OpenApiDocument
}

/** The model of `widgetsDocument(query)`. */
export function widgetsModel(query?: Array<Record<string, unknown>>): SpecModel {
	return modelOf(widgetsDocument(query))
}

/** One row of the cohort, holding a value for every probed field. */
export const ROW = { active: true, id: "w1", meta: { a: 1 }, name: "Ann", price: 3, tags: ["red"] }

/** An `x-query` declaration from the document, naming what `fields` says. */
export function tagQuery(fields: Partial<QueryCapability> = {}): QueryCapability {
	return { filterable: [], searchable: [], selectable: [], sortable: [], source: "tag", ...fields }
}

/** The list operation, its conventions patched by `patch` and without the roles in `omit`. */
export function listing(patch: Partial<QueryConventions>, ...omit: Array<keyof QueryConventions>): OperationModel {
	const listOp = op(widgetsModel(), "listWidgets")
	const conventions = { ...listOp.conventions, ...patch }
	for (const role of omit) delete conventions[role]
	return { ...listOp, conventions }
}

/** A context on the widgets list holding one row, with `fields` laid over it. */
export function stage(respond: Responder, fields: Partial<CheckContext> = {}) {
	return contextFor(widgetsModel(), "listWidgets", {
		respond,
		fields: { query: tagQuery(), records: [ROW], ...fields },
	})
}

/** Answers every request `ok`, except those whose query includes `value` in some parameter, which get `status`. */
export function refusing(status: number, ...values: string[]): Responder {
	return (_method, _path, options) => {
		const spelled = Object.values(options.query ?? {}).map(String)
		const refused = values.some((value) => spelled.some((text) => text.includes(value)))
		return refused ? { body: [], status } : { body: [ROW], status: 200 }
	}
}

/** Answers with the status of the first prefix some query value starts with, and `ok` otherwise. */
export function answering(statusByPrefix: Record<string, number>): Responder {
	return (_method, _path, options) => {
		const spelled = Object.values(options.query ?? {}).map(String)
		const hit = Object.entries(statusByPrefix).find(([prefix]) => spelled.some((text) => text.startsWith(prefix)))
		return hit === undefined ? { body: [ROW], status: 200 } : { body: [], status: hit[1] }
	}
}

/** The query each request carried, in the order they were sent. */
export function queries(sent: readonly Sent[]): unknown[] {
	return sent.map((request) => request.options.query)
}
