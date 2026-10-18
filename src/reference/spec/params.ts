/** Path and query parameters, and the sort spellings each dialect's parameters expect. */

import type { Dialect } from "../dialect/types.ts"
import type { EntityDef } from "../model/types.ts"
import { fieldsWhere } from "../model/fields.ts"
import type { Json, SpecContext } from "./types.ts"

/** A query parameter as `[name, schema, description]`. */
export type QueryParam = [string, Json, string]

/** The schema of an identifier in a path, matching the identity it names. */
function idSchema(ctx: SpecContext, param: string): Json {
	if (ctx.shape.bareIdParams === true) return { type: "string" }
	const owner = ctx.entities.find((entity) => entity.itemParam === param)
	const identity = owner?.fields.find((field) => field.name === owner.identity)
	if (identity?.type === "integer") return { minimum: 1, type: "integer" }
	if (identity?.format === "uuid") return { format: "uuid", type: "string" }
	return { type: "string" }
}

export function pathParams(ctx: SpecContext, entity: EntityDef, includeItem: boolean): Json[] {
	const params: Json[] = entity.parents.map((name) => ({
		in: "path",
		name,
		required: true,
		schema: idSchema(ctx, name),
		...(name === "project_id" ? { "x-root": true } : {}),
	}))
	if (includeItem) {
		params.push({ in: "path", name: entity.itemParam, required: true, schema: idSchema(ctx, entity.itemParam) })
	}
	return params
}

export function tenantParam(entity: EntityDef): string {
	return entity.parents[0] ?? "project_id"
}

/**
 * The sort parameter's description, demonstrating the grammar this dialect expects.
 *
 * A document that expects `-created_at` and describes `field.asc` is lying, and oat would infer
 * the wrong grammar from it — correctly, since the document is the only thing it can read.
 */
function sortDescription(dialect: Dialect): string {
	switch (dialect.sortGrammar ?? "dotted") {
		case "prefixed":
			return "Sort by field; prefix with - for descending. e.g. -created_at, name"
		case "colon":
			return "Sort: field:asc or field:desc, comma-separated. e.g. created_at:desc"
		case "spaced":
			return "Sort: field asc or field desc, comma-separated. e.g. created_at desc"
		case "dotted":
			return "Sort: field[.asc|.desc][.nullsfirst|.nullslast], comma-separated"
		case "template":
			return "Sort: field_ascending or field_descending, comma-separated. e.g. created_at_descending"
	}
}

function filterDescription(dialect: Dialect): string {
	return dialect.grammar === "postgrest"
		? "PostgREST-style filter expression: field.op.value, and(...), or(...)"
		: dialect.grammar === "template"
			? "One filter term per parameter, repeated: <conj>_<field>_<op>_<value>. e.g. and_status_eq_active"
			: "Filter expression: field=op:value, comma-separated. e.g. status=eq:active"
}

function filterParams(dialect: Dialect, entity: EntityDef): QueryParam[] {
	if (dialect.grammar !== "equality") return [[dialect.params.filter, { type: "string" }, filterDescription(dialect)]]
	/* One parameter per filterable field, which *is* the filter language here. Declaring them
	 * individually is the only way a document can express this shape, and it is how oat learns
	 * what may be filtered on. */
	return fieldsWhere(entity, "filterable").map((field) => {
		const declared = entity.fields.find((f) => f.name === field)
		const numeric = declared?.type === "integer" || declared?.type === "number"
		return [
			field,
			declared?.enum === undefined ? { type: numeric ? "number" : "string" } : { enum: declared.enum, type: "string" },
			`Exact match on ${field}`,
		]
	})
}

/* Exactly one paging model is published, because that is what a real document does — and a
 * document advertising a parameter the backend ignores is itself a defect oat reports. */
function pagingParams(dialect: Dialect): QueryParam[] {
	const p = dialect.params
	const params: QueryParam[] = []
	if (p.page !== undefined) {
		params.push([p.page, { minimum: 1, type: "integer" }, "1-based page number"])
	}
	if (p.offset !== undefined) {
		params.push([p.offset, { minimum: 0, type: "integer" }, "Number of records to skip"])
	}
	if (p.cursor !== undefined) {
		params.push([p.cursor, { type: "string" }, "Opaque forward cursor; takes precedence over page"])
	}
	return params
}

export function listQueryParams(dialect: Dialect, entity: EntityDef): QueryParam[] {
	const p = dialect.params
	const params = filterParams(dialect, entity)
	params.push(
		[p.order, { type: "string" }, sortDescription(dialect)],
		[
			/* JSON:API carries the resource type in the parameter *name*, so the name itself is
			 * part of the grammar and has to be declared per entity. */
			dialect.selectGrammar === "bracketed" ? `${p.select}[${entity.name}]` : p.select,
			{ type: "string" },
			"Comma-separated sparse fieldset; * selects all",
		],
		[p.search, { maxLength: 200, type: "string" }, "Free-text search across searchable fields"],
	)
	if (p.searchMode !== undefined) {
		params.push([
			p.searchMode,
			{ default: "contains", enum: ["contains", "prefix"], type: "string" },
			"How the search term matches: anywhere in a field, or at its start",
		])
	}
	params.push(...pagingParams(dialect))
	return params
}

/** A canonical `field.dir` order spelled in the dialect's own sort grammar. */
export function renderOrder(dialect: Dialect, canonical: string): string {
	const [field = "", direction = "asc"] = canonical.split(".")
	switch (dialect.sortGrammar ?? "dotted") {
		case "prefixed":
			return direction === "desc" ? `-${field}` : field
		case "colon":
			return `${field}:${direction}`
		case "spaced":
			return `${field} ${direction}`
		case "dotted":
			return `${field}.${direction}`
		case "template":
			return `${field}_${direction === "desc" ? "descending" : "ascending"}`
	}
}
