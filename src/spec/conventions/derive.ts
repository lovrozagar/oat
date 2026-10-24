import type { CollectionShape } from "../collection/shape.ts"
import { parseFilterGrammar } from "../render/filter-parse.ts"
import { parseSortGrammar } from "../render/sort-parse.ts"
import { SORT_PRESETS } from "../render/sort.ts"
import type { ParameterObject } from "../types.ts"
import { inferGrammar, inferSelectGrammar, inferSortGrammar } from "./infer.ts"
import { parameterNamed, resolvePagingRoles, roleName } from "./roles.ts"
import type { QueryConventions } from "./types.ts"

/** What the document says beside the parameters: its `x-query` grammars and response headers. */
export interface ConventionSources {
	declared?: { grammar?: unknown; sortGrammar?: unknown } | undefined
	/** Told when the filter grammar could not be recognized and nothing declared it. */
	onGuess?: (message: string) => void
	/** Response headers the success response declares, by name. */
	responseHeaders?: readonly string[]
}

type FilterConventions = Pick<QueryConventions, "grammar" | "filterGrammar" | "grammarDeclared">
type SortConventions = Pick<QueryConventions, "sortGrammar" | "sortSpec" | "sortDeclared">
type RoleConventions = Pick<
	QueryConventions,
	"filter" | "order" | "select" | "search" | "searchMode" | "cursor" | "limit" | "page" | "offset"
>

/* Where each envelope role is read from the collection's pagination. */
const ENVELOPE = [
	["total", "countKey"],
	["hasMore", "hasMoreKey"],
	["nextCursor", "cursorKey"],
	["page", "pageKey"],
	["limit", "limitKey"],
] as const

export function deriveQueryConventions(
	parameters: readonly ParameterObject[],
	collection: CollectionShape | null,
	sources: ConventionSources = {},
): QueryConventions {
	const query = parameters.filter((p) => p.in === "query")
	const conventions: QueryConventions = {
		envelope: envelopeOf(collection),
		...filterConventions(query, sources),
		selectGrammar: inferSelectGrammar(parameterNamed(query, roleName(query, "select"))),
		...declaredSort(sources.declared?.sortGrammar, parameterNamed(query, roleName(query, "order"))),
	}
	const link = (sources.responseHeaders ?? []).find((name) => name.toLowerCase() === "link")
	if (link !== undefined) conventions.linkHeader = link
	return Object.assign(conventions, roles(query))
}

function filterConventions(query: readonly ParameterObject[], sources: ConventionSources): FilterConventions {
	const declared = sources.declared?.grammar
	const filterParam = parameterNamed(query, roleName(query, "filter"))
	const stated = statedGrammar(declared)
	if (stated !== undefined) return stated
	const inferred = inferGrammar(filterParam)
	/* A single free-text `filter` parameter almost never means equality-per-field; it means a grammar
	 * oat could not recognize. Writing `?name=value` anyway would send parameters the document never
	 * declared and read the shrug that comes back as a defect, so no filter term is written at all. */
	const unrecognized = inferred === "equality" && filterParam?.schema?.type === "string"
	if (unrecognized && declared === undefined) sources.onGuess?.(unrecognizedMessage(filterParam.name))
	return { grammar: unrecognized ? "unrecognized" : inferred }
}

/** The filter grammar `x-query` names or describes as a template, when it does so readably. */
function statedGrammar(declared: unknown): FilterConventions | undefined {
	if (declared === "postgrest" || declared === "colon" || declared === "equality") {
		return { grammar: declared, grammarDeclared: true }
	}
	/* An object that cannot be read is a gap `x-query`'s validation records; oat infers instead. */
	const template = typeof declared === "object" ? parseFilterGrammar(declared) : null
	return template?.ok === true
		? { grammar: "template", filterGrammar: template.spec, grammarDeclared: true }
		: undefined
}

function unrecognizedMessage(name: string): string {
	return (
		`parameter "${name}" takes a filter expression whose grammar could not be ` +
		"recognized from its description or examples, so oat writes no filter terms for it. " +
		'Declare it with x-query: { grammar: "postgrest" | "colon" | "equality" }, or describe it as a ' +
		'template: { grammar: { term: "{conj}_{field}_{op}_{value}", ops: { eq: "eq" }, … } }'
	)
}

/** A declared sort grammar, or the inferred one when none was declared or it cannot be read. */
function declaredSort(declared: unknown, order: ParameterObject | undefined): SortConventions {
	if (typeof declared === "string" && Object.hasOwn(SORT_PRESETS, declared)) {
		return { sortDeclared: true, sortGrammar: declared as keyof typeof SORT_PRESETS }
	}
	/* An object that cannot be read is a gap `x-query`'s validation records; oat infers instead. */
	const parsed = typeof declared === "object" ? parseSortGrammar(declared) : null
	if (parsed?.ok === true) return { sortDeclared: true, sortGrammar: "template", sortSpec: parsed.spec }
	return { sortGrammar: inferSortGrammar(order) }
}

/** The parameter playing each role, for the roles the endpoint has. */
function roles(query: readonly ParameterObject[]): RoleConventions {
	const search = roleName(query, "search")
	const paging = resolvePagingRoles(query)
	const found: Record<keyof RoleConventions, string | undefined> = {
		filter: roleName(query, "filter"),
		order: roleName(query, "order"),
		select: roleName(query, "select"),
		search,
		/* A bare `mode` is too common to steal unless a search role is already present. */
		searchMode: search === undefined ? undefined : roleName(query, "searchMode"),
		cursor: roleName(query, "cursor"),
		limit: paging.limit,
		page: paging.page,
		offset: paging.offset,
	}
	return Object.fromEntries(Object.entries(found).filter(([, name]) => name !== undefined)) as RoleConventions
}

/* The envelope is already derived from the 200 schema when the shape was resolved — reuse it
 * rather than matching on literal key names a second time. */
function envelopeOf(collection: CollectionShape | null): QueryConventions["envelope"] {
	const envelope: QueryConventions["envelope"] = {}
	for (const [role, key] of ENVELOPE) {
		const name = collection?.pagination[key]
		if (name !== undefined) envelope[role] = name
	}
	return envelope
}
