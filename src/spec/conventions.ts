/**
 * What a list endpoint's query parameters and response envelope *mean*, derived from the
 * document rather than assumed.
 *
 * Checks used to match on literal names — `"filter"`, `"page"`, `envelope.hasMore` — which made
 * roughly half of them fire only against APIs that happened to share the fixture's spelling.
 * Everywhere else they were skipped, and skipped silently, so a quiet run on an unfamiliar API
 * read exactly like a clean one.
 *
 * Names are matched against the aliases real APIs actually use, and the shape of the declared
 * schema breaks ties. Anything still ambiguous is left `undefined` — the check then reports that
 * it did not apply, and `x-query` can state the answer outright.
 */

import type { CollectionShape } from "./collection.ts"
import type { ParameterObject, SchemaObject } from "./types.ts"

/** How filter values are spelled. Determines what oat can express, not merely what it sends. */
export type FilterGrammar =
	/** `field.op.value`, with `and(...)`/`or(...)` — PostgREST and friends. */
	| "postgrest"
	/** `field=op:value`, e.g. `?price=gt:10`. */
	| "colon"
	/** One parameter per field, equality only — `?status=active`. */
	| "equality"

/**
 * How a sort direction is spelled.
 *
 * The role of the parameter and the *grammar* of its value are separate problems, and generalising
 * only the first is a half-measure: an API that names the parameter `sort` but expects `-name`
 * receives `name.asc`, ignores or rejects it, and reads as a backend with broken sorting rather
 * than one speaking a dialect oat cannot write.
 */
export type SortGrammar =
	/** `field.asc` / `field.desc`, comma-separated — PostgREST. */
	| "dotted"
	/** `-field` for descending, bare for ascending — JSON:API. */
	| "prefixed"
	/** `field:asc` / `field:desc`. */
	| "colon"
	/** `field asc` / `field desc`, as SQL writes it. */
	| "spaced"

/** How a sparse fieldset is spelled. */
export type SelectGrammar =
	/** `id,name` — comma-separated field names. */
	| "csv"
	/** `fields[type]=id,name` — JSON:API's per-type bracket form. */
	| "bracketed"

export interface QueryConventions {
	/** Parameter carrying a filter expression, when the endpoint has one. */
	filter?: string
	/** Parameter selecting sort order. */
	order?: string
	/** Parameter selecting a sparse fieldset. */
	select?: string
	/** Free-text search parameter. */
	search?: string
	/** Page-size parameter. */
	limit?: string
	/** 1-based page number. */
	page?: string
	/** Zero-based row offset, where the API pages by offset rather than page number. */
	offset?: string
	/** Opaque forward cursor. */
	cursor?: string
	grammar: FilterGrammar
	/** How sort directions are written for the `order` parameter. */
	sortGrammar: SortGrammar
	/** How a sparse fieldset is written for the `select` parameter. */
	selectGrammar: SelectGrammar
	/**
	 * Response header carrying RFC 8288 pagination links, when the document declares one.
	 *
	 * Its presence changes how "are there more pages" is answered: under Link pagination the
	 * *absence* of `rel="next"` means no, so a response with no header at all is a definite
	 * "false" rather than an unknown. Without knowing the API publishes such a header, the two
	 * are indistinguishable and the check that asks has to stand down.
	 */
	linkHeader?: string
	/** Where each is spelled in the response envelope, when the schema declares one. */
	envelope: {
		total?: string
		hasMore?: string
		nextCursor?: string
		page?: string
		limit?: string
	}
}

/*
 * Aliases seen across real APIs. Order matters only for readability; a parameter is matched
 * case-insensitively and with separators normalised, so `perPage`, `per_page` and `PerPage` are
 * one entry.
 */
const ALIASES: Record<
	"filter" | "order" | "select" | "search" | "limit" | "page" | "offset" | "cursor",
	string[]
> = {
	cursor: ["cursor", "after", "starting_after", "next", "page_token", "continuation"],
	filter: ["filter", "where", "query", "conditions"],
	limit: ["limit", "per_page", "page_size", "pagesize", "count", "max_results", "top", "size"],
	offset: ["offset", "skip", "start", "from"],
	order: ["order", "order_by", "sort", "sort_by", "ordering"],
	page: ["page", "page_number", "pagenum", "p"],
	search: ["q", "search", "query_text", "term", "keyword", "text"],
	select: ["select", "fields", "field", "include_fields", "projection", "only"],
}

function normalise(name: string): string {
	return name
		/* A bracketed suffix is a *value* carried in the parameter name — `fields[articles]`,
		 * `filter[status]` — not part of the role's name. Matching the whole string against the
		 * alias list would fail to recognise the role at all, and the check that needed it would
		 * report itself inapplicable against an API that plainly supports it. */
		.replace(/\[[^\]]*\]$/, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[-\s]/g, "_")
}

function schemaOf(parameter: ParameterObject): SchemaObject {
	return parameter.schema ?? {}
}

function isInteger(parameter: ParameterObject): boolean {
	const type = schemaOf(parameter).type
	return type === "integer" || type === "number"
}

/**
 * `limit` and `page` are both bare integers, and several APIs spell one of them with a word that
 * belongs to the other's alias list — `count` most notoriously. The declared schema settles it:
 * a page size is the one with an upper bound, a page number the one that starts at 1.
 */
function resolvePagingRoles(
	candidates: ParameterObject[],
): { limit?: string; page?: string; offset?: string } {
	const roles: { limit?: string; page?: string; offset?: string } = {}

	for (const parameter of candidates) {
		if (!isInteger(parameter)) continue
		const name = normalise(parameter.name)
		const schema = schemaOf(parameter)
		const hasMaximum = typeof schema.maximum === "number"
		const startsAtOne = schema.minimum === 1
		const hasDefault = schema.default !== undefined

		if (roles.limit === undefined && ALIASES.limit.includes(name)) {
			/* `count` is a page size only when it reads like one; otherwise it is a total. */
			if (name !== "count" || hasMaximum || hasDefault) {
				roles.limit = parameter.name
				continue
			}
		}
		if (roles.page === undefined && ALIASES.page.includes(name) && !hasMaximum) {
			roles.page = parameter.name
			continue
		}
		if (roles.offset === undefined && ALIASES.offset.includes(name)) {
			roles.offset = parameter.name
			continue
		}
		/* Unnamed but unmistakable: a bounded integer with a default is a page size. */
		if (roles.limit === undefined && hasMaximum && hasDefault) roles.limit = parameter.name
		else if (roles.page === undefined && startsAtOne && !hasMaximum) roles.page = parameter.name
	}

	return roles
}

/**
 * Infers the filter grammar from the parameter's declared examples, which is where APIs
 * describing a grammar almost always demonstrate it. Defaults to one-parameter-per-field
 * equality — the assumption that holds for the widest range of APIs, and the one whose checks
 * degrade most gracefully when wrong.
 */
function inferGrammar(filter: ParameterObject | undefined): FilterGrammar {
	if (filter === undefined) return "equality"
	const schema = schemaOf(filter)
	const samples = [
		...(Array.isArray(schema.examples) ? schema.examples : []),
		...(schema.example === undefined ? [] : [schema.example]),
		...(typeof filter.description === "string" ? [filter.description] : []),
	].filter((value): value is string => typeof value === "string")

	const text = samples.join(" ")
	/* Named outright in the description is the strongest signal — documents that describe a
	 * grammar almost always name it before demonstrating it. */
	if (/postgrest/i.test(text)) return "postgrest"
	if (/\b[\w.]+\.(eq|neq|gt|gte|lt|lte|like|ilike|in|nin|is|contains)\b/.test(text)) return "postgrest"
	/* `field.op.value` written as a schema rather than an instance. */
	if (/\bfield\.op\.value\b/i.test(text)) return "postgrest"
	if (/\b[\w.]+=(eq|neq|gt|gte|lt|lte|like|in):/.test(text)) return "colon"
	return "equality"
}

/**
 * Infers the sort grammar from what the document demonstrates.
 *
 * Descriptions and examples are where an API shows its hand — `sort=-created_at` is unambiguous,
 * and so is `field:desc`. Defaults to the dotted form, which is the most common and, being an
 * unrecognised token rather than a wrong direction, fails loudly rather than silently sorting
 * backwards when wrong.
 */
function inferSortGrammar(order: ParameterObject | undefined): SortGrammar {
	if (order === undefined) return "dotted"
	const schema = order.schema ?? {}
	const text = [
		...(Array.isArray(schema.examples) ? schema.examples : []),
		...(schema.example === undefined ? [] : [schema.example]),
		...(typeof order.description === "string" ? [order.description] : []),
	]
		.filter((value): value is string => typeof value === "string")
		.join(" ")

	if (/\b[\w.]+\.(asc|desc)\b/i.test(text)) return "dotted"
	if (/\b[\w.]+:(asc|desc)\b/i.test(text)) return "colon"
	if (/\b[\w.]+\s+(asc|desc)\b/i.test(text)) return "spaced"
	/* A leading minus is the JSON:API convention; the "-" must precede a field name, not merely
	 * appear in prose, so the match is anchored to a token boundary. */
	if (/(^|[\s,="'])-[a-z_][\w.]*/i.test(text) && /descend/i.test(text)) return "prefixed"
	if (/(^|[\s,="'])-[a-z_][\w.]*/i.test(text)) return "prefixed"
	return "dotted"
}

/** Infers how a sparse fieldset is written. `fields[type]=` is JSON:API's and unmistakable. */
function inferSelectGrammar(select: ParameterObject | undefined): SelectGrammar {
	if (select === undefined) return "csv"
	if (/\[[^\]]+\]$/.test(select.name)) return "bracketed"
	const description = typeof select.description === "string" ? select.description : ""
	return /fields\[[^\]]+\]/.test(description) ? "bracketed" : "csv"
}

export function deriveQueryConventions(
	parameters: readonly ParameterObject[],
	collection: CollectionShape | null,
	declared?: { grammar?: string },
	onGuess?: (message: string) => void,
	/** Response headers the success response declares, by name. */
	responseHeaders: readonly string[] = [],
): QueryConventions {
	const query = parameters.filter((p) => p.in === "query")
	const byRole = (role: keyof typeof ALIASES): string | undefined =>
		query.find((p) => ALIASES[role].includes(normalise(p.name)))?.name

	const paging = resolvePagingRoles(query)
	const filterName = byRole("filter")
	const filterParam = query.find((p) => p.name === filterName)

	const grammar: FilterGrammar =
		declared?.grammar === "postgrest" || declared?.grammar === "colon" || declared?.grammar === "equality"
			? declared.grammar
			: inferGrammar(filterParam)

	if (
		declared?.grammar === undefined &&
		filterParam !== undefined &&
		grammar === "equality" &&
		schemaOf(filterParam).type === "string"
	) {
		/* A single free-text `filter` parameter almost never means equality-per-field; it means a
		 * grammar oat could not recognise. Saying so beats sending `?name=value` and reading the
		 * shrug that comes back as a defect. */
		onGuess?.(
			`parameter "${filterParam.name}" takes a filter expression whose grammar could not be ` +
				"recognised from its description or examples, so oat assumed one parameter per field. " +
				'Declare it with x-query: { grammar: "postgrest" | "colon" | "equality" }',
		)
	}

	const orderParam = query.find((p) => p.name === byRole("order"))
	const selectParam = query.find((p) => p.name === byRole("select"))

	const conventions: QueryConventions = {
		envelope: {},
		grammar,
		selectGrammar: inferSelectGrammar(selectParam),
		sortGrammar: inferSortGrammar(orderParam),
	}

	const link = responseHeaders.find((name) => name.toLowerCase() === "link")
	if (link !== undefined) conventions.linkHeader = link

	if (filterName !== undefined) conventions.filter = filterName
	const order = byRole("order")
	if (order !== undefined) conventions.order = order
	const select = byRole("select")
	if (select !== undefined) conventions.select = select
	const search = byRole("search")
	if (search !== undefined) conventions.search = search
	const cursor = byRole("cursor")
	if (cursor !== undefined) conventions.cursor = cursor
	if (paging.limit !== undefined) conventions.limit = paging.limit
	if (paging.page !== undefined) conventions.page = paging.page
	if (paging.offset !== undefined) conventions.offset = paging.offset

	/* The envelope is already derived from the 200 schema when the shape was resolved — reuse it
	 * rather than matching on literal key names a second time. */
	const pagination = collection?.pagination
	if (pagination?.countKey !== undefined) conventions.envelope.total = pagination.countKey
	if (pagination?.hasMoreKey !== undefined) conventions.envelope.hasMore = pagination.hasMoreKey
	if (pagination?.cursorKey !== undefined) conventions.envelope.nextCursor = pagination.cursorKey
	if (pagination?.pageKey !== undefined) conventions.envelope.page = pagination.pageKey
	if (pagination?.limitKey !== undefined) conventions.envelope.limit = pagination.limitKey

	return conventions
}

/** Renders one filter term in whichever grammar the endpoint speaks. */
export function filterTerm(
	conventions: QueryConventions,
	field: string,
	op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like",
	value: string | number,
): Record<string, string> | null {
	const parameter = conventions.filter
	switch (conventions.grammar) {
		case "postgrest":
			if (parameter === undefined) return null
			return { [parameter]: `${field}.${op}.${value}` }
		case "colon":
			if (parameter === undefined) return null
			return { [parameter]: `${field}=${op}:${value}` }
		case "equality":
			/* Only equality is expressible, so anything else has no representation and the check
			 * that wanted it must stand down rather than send something meaningless. */
			return op === "eq" ? { [field]: String(value) } : null
	}
}


/** Renders a sort term in whichever grammar the endpoint speaks. */
export function sortTerm(
	conventions: QueryConventions,
	field: string,
	direction: "asc" | "desc",
): string {
	switch (conventions.sortGrammar) {
		case "dotted":
			return `${field}.${direction}`
		case "colon":
			return `${field}:${direction}`
		case "spaced":
			return `${field} ${direction}`
		case "prefixed":
			/* Ascending is the bare field name: there is no "+" form in this grammar, and sending
			 * one would be a token the API has never seen. */
			return direction === "desc" ? `-${field}` : field
	}
}

/**
 * Renders a sparse fieldset, returning the parameter name alongside the value.
 *
 * JSON:API puts the resource type in the parameter name rather than the value, so the two cannot
 * be chosen independently — which is why this returns a pair rather than a string.
 */
export function selectTerm(
	conventions: QueryConventions,
	fields: readonly string[],
	resource: string,
): Record<string, string> | null {
	const parameter = conventions.select
	if (parameter === undefined) return null
	const value = fields.join(",")
	if (conventions.selectGrammar === "csv") return { [parameter]: value }
	/* Already bracketed in the document — `fields[articles]` — so the name is used verbatim.
	 * Otherwise the resource name is inserted, which is what the grammar requires. */
	const name = /\[[^\]]+\]$/.test(parameter) ? parameter : `${parameter}[${resource}]`
	return { [name]: value }
}
