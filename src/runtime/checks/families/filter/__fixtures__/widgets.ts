import type { Finding, FindingCollector } from "../../../../finding.ts"
import type { Record_ } from "../../../../world/records.ts"
import type { QueryConventions } from "../../../../../spec/conventions/types.ts"
import { FILTER_PRESETS } from "../../../../../spec/render/filter-presets.ts"
import type { FilterGrammarSpec } from "../../../../../spec/render/filter-types.ts"
import type { FilterOp } from "../../../../../config/types/query.ts"
import type { JsonSchema, OpenApiDocument } from "../../../../../spec/types.ts"
import { contextFor, modelOf, op, type Responder, type Sent } from "../../../__fixtures__/harness.ts"
import type { CheckContext, WriteContext } from "../../../core/context.ts"
import { backend, type Behavior, PATH, PROPERTIES } from "./backend.ts"

/*
 * One widget listing, and a context for a filter check against it with `backend.ts` answering.
 */

export const LIST = "widget.list"
export interface DocOptions {
	/** Merged over `{ grammar: "postgrest", maxLimit: 50 }`. */
	xQuery?: Record<string, unknown>
	/** Whether the listing has a `filter` parameter; default true. */
	filterParam?: boolean
	/** Whether the listing pages by page number; default false (one page holds the set). */
	paged?: boolean
	/** The identity's schema in place of a plain string. */
	idSchema?: JsonSchema
}

export function widgetDoc(options: DocOptions = {}): OpenApiDocument {
	const parameters = [
		...(options.filterParam === false ? [] : [{ in: "query", name: "filter", schema: { type: "string" } }]),
		{ in: "query", name: "limit", schema: { maximum: 50, minimum: 1, type: "integer" } },
		...(options.paged === true ? [{ in: "query", name: "page", schema: { minimum: 1, type: "integer" } }] : []),
	]
	const properties = { ...PROPERTIES, ...(options.idSchema === undefined ? {} : { id: options.idSchema }) }
	const items = { properties, required: ["id"], type: "object" }
	return {
		info: { title: "widgets", version: "1" },
		openapi: "3.1.0",
		paths: {
			[PATH]: {
				get: {
					operationId: LIST,
					parameters,
					responses: {
						"200": {
							content: {
								"application/json": {
									schema: { properties: { widgets: { items, type: "array" } }, required: ["widgets"], type: "object" },
								},
							},
							description: "ok",
						},
					},
					"x-entity": { action: "list", identity: "id", name: "widget" },
					"x-query": { grammar: "postgrest", maxLimit: 50, ...options.xQuery },
				},
			},
		},
	} as unknown as OpenApiDocument
}

/** Conventions under a template grammar: postgrest, with `change` applied to its spec. */
export function grammar(change: (spec: FilterGrammarSpec) => FilterGrammarSpec): Partial<QueryConventions> {
	return { filterGrammar: change({ ...FILTER_PRESETS.postgrest }), grammar: "template" }
}

/** Postgrest that cannot write a value holding any of `chars`. */
export function reserving(chars: string): Partial<QueryConventions> {
	return grammar((spec) => ({ ...spec, reserved: chars }))
}

/** Postgrest without the named operators. */
export function without(...ops: FilterOp[]): Partial<QueryConventions> {
	return grammar((spec) => ({
		...spec,
		ops: Object.fromEntries(Object.entries(spec.ops).filter(([name]) => !ops.includes(name as FilterOp))),
	}))
}

export interface StageOptions {
	records: Record_[]
	/** What the backend holds; the cohort by default. */
	store?: Record_[] | ((call: number) => Record_[])
	doc?: DocOptions
	behavior?: Behavior
	/** Answers instead of the backend. */
	respond?: Responder
	/** Merged over the listing's derived conventions. */
	conventions?: Partial<QueryConventions>
	fields?: Partial<CheckContext>
}

export interface Stage {
	ctx: WriteContext
	sent: Sent[]
	findings: FindingCollector
}

/** A context for one filter check against the widget listing. */
export function stage(options: StageOptions): Stage {
	const model = modelOf(widgetDoc(options.doc))
	const listOp = op(model, LIST)
	const respond = options.respond ?? backend(options.store ?? options.records, options.behavior)
	const conventions = options.conventions
	return contextFor(model, LIST, {
		respond,
		fields: {
			collectionKey: "widgets",
			identity: "id",
			query: listOp.query,
			records: options.records,
			...(conventions === undefined
				? {}
				: { listOp: { ...listOp, conventions: { ...listOp.conventions, ...conventions } } }),
			...options.fields,
		},
	})
}

/** A store that gains `extra` once `after` requests were answered: another writer moving the collection. */
export function growing(rows: Record_[], after: number, extra: Record_): (call: number) => Record_[] {
	return (call) => (call > after ? [...rows, extra] : rows)
}

/** Every filtered request refused. */
export const REFUSE_FILTERED: Behavior = { status: (query) => (query.filter === undefined ? undefined : 400) }

/** `doc`, paged, with every page the first: no whole-set read of it completes. */
export function endless(doc: DocOptions = {}): Pick<StageOptions, "behavior" | "doc"> {
	return { behavior: { ignorePage: true }, doc: { ...doc, paged: true } }
}

/** The `filter` value of each request sent, in order; `-` for a request without one. */
export function filters(sent: Sent[]): string[] {
	return sent.map((request) => String((request.options.query as Record<string, unknown> | undefined)?.filter ?? "-"))
}

/** The one finding a check reported. */
export function only(findings: FindingCollector): Finding {
	const [finding, ...rest] = findings.findings
	if (finding === undefined || rest.length > 0) throw new Error(`expected one finding, got ${findings.findings.length}`)
	return finding
}
