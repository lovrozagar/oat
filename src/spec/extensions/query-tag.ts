/**
 * `x-query`: which fields a list endpoint filters, sorts, searches and selects by. A declared tag
 * is read as it stands; without one, an endpoint that takes a query parameter gets every scalar
 * property guessed and a recorded gap saying so.
 */

import type { FilterableField, QueryCapabilities, SortableField } from "../../config/types/query.ts"
import { deriveQueryConventions } from "../conventions/derive.ts"
import { parseQueryCatalog } from "../query/parse-catalog.ts"
import type { QueryTag } from "../query/tag.ts"
import type { RawOf } from "../../config/types/raw.ts"
import type { Endpoint, JsonSchema } from "../types.ts"
import type { GapCollector } from "./gaps.ts"
import { extObject } from "./tag.ts"
import { scalarKinds } from "../schema.ts"

export interface QueryCapability {
	filterable: string[]
	sortable: string[]
	searchable: string[]
	selectable: string[]
	maxLimit?: number
	defaultOrder?: string
	stableTiebreak?: string
	source: "tag" | "heuristic"
	/** Structured `x-query` extras. Absent on a heuristic guess. */
	catalog?: QueryCapabilities
	/** True when the tag included a `filterable` key, even if the list is empty. */
	filterableDeclared?: boolean
	sortableDeclared?: boolean
	searchableDeclared?: boolean
	selectableDeclared?: boolean
	/** Structured rows when the tag used objects; otherwise one `{ field }` per name. */
	filterFields?: FilterableField[]
	sortableFields?: SortableField[]
}

function scalarProperties(schema: JsonSchema): string[] {
	const props = schema.properties
	if (props === null || typeof props !== "object") return []
	const out: string[] = []
	for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
		if (raw === null || typeof raw !== "object") continue
		if (scalarKinds(raw) !== undefined) out.push(name)
	}
	return out
}

function declared(tag: RawOf<QueryTag>): QueryCapability {
	const catalog = parseQueryCatalog(tag)
	const fields = catalog.filterable ?? []
	const sortFields = catalog.sortable ?? []
	const cap: QueryCapability = {
		catalog,
		filterFields: fields,
		filterable: fields.map((field) => field.field),
		filterableDeclared: tag.filterable !== undefined,
		/* The catalog keeps a searchable or selectable list whenever the tag holds one. */
		searchable: catalog.searchable ?? [],
		searchableDeclared: tag.searchable !== undefined,
		selectable: catalog.selectable ?? [],
		selectableDeclared: tag.selectable !== undefined,
		sortable: sortFields.map((field) => field.field),
		sortableDeclared: tag.sortable !== undefined,
		sortableFields: sortFields,
		source: "tag",
	}
	if (typeof tag.maxLimit === "number") cap.maxLimit = tag.maxLimit
	if (typeof tag.defaultOrder === "string") cap.defaultOrder = tag.defaultOrder
	if (typeof tag.stableTiebreak === "string") cap.stableTiebreak = tag.stableTiebreak
	return cap
}

function guessed(endpoint: Endpoint, itemSchema: JsonSchema | null, gaps?: GapCollector): QueryCapability | null {
	const params = (endpoint.op.parameters ?? []).filter((p) => p.in === "query")
	/* Same aliases the checks already use — `sort`/`fields`/`q`/`per_page`, not only the
	 * fixture spellings `filter`/`order`/`select`/`limit`. Pagination-only params do not
	 * count: a `page`/`limit` list is not a query grammar. */
	const conventions = deriveQueryConventions(params, null)
	const roles = [conventions.filter, conventions.order, conventions.select, conventions.search].filter(
		(name): name is string => name !== undefined,
	)
	if (roles.length === 0) return null

	const scalars = itemSchema === null ? [] : scalarProperties(itemSchema)
	gaps?.record(
		endpoint.operationId,
		"x-query",
		`endpoint accepts ${roles.join("/")} ` +
			`but does not declare which fields support them. Assuming all ${scalars.length} scalar ` +
			"properties, which will produce false failures on unindexed fields",
	)

	const cap: QueryCapability = {
		filterable: scalars,
		searchable: scalars.filter((f) => /name|title|slug|label|description|email/i.test(f)),
		selectable: scalars,
		/* A parameter of the list's own path holds one value across the listing: ordering by it shows nothing. */
		sortable: scalars.filter((field) => !endpoint.path.includes(`{${field}}`)),
		source: "heuristic",
	}
	if (conventions.limit !== undefined) {
		const max = params.find((p) => p.name === conventions.limit)?.schema?.maximum
		if (typeof max === "number") cap.maxLimit = max
	}
	return cap
}

export function readQueryCapability(
	endpoint: Endpoint,
	itemSchema: JsonSchema | null,
	gaps?: GapCollector,
): QueryCapability | null {
	const tag = extObject<QueryTag>(endpoint.op, "x-query")
	return tag === undefined ? guessed(endpoint, itemSchema, gaps) : declared(tag)
}
