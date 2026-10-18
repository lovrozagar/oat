import type { EntityConfig, OatConfig } from "../../config/types/config.ts"
import type { QueryCapabilities } from "../../config/types/query.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { describeFilterGrammar } from "../../spec/render/filter-describe.ts"
import type { EffectiveQueryCapabilities } from "../../spec/query/effective.ts"
import { mergeQueryCapabilities } from "../../spec/query/merge.ts"
import { describeSortGrammar } from "../../spec/render/sort-parse.ts"
import { catalogCheckPreview } from "./catalog-checks.ts"
import { listOperation, sortedEntities } from "./describe.ts"

type Caps = EffectiveQueryCapabilities

/** What config says about query capabilities, over and above the document. */
export interface CatalogConfig {
	query?: QueryCapabilities
	entities?: Record<string, EntityConfig>
	hooks?: Pick<NonNullable<OatConfig["hooks"]>, "resolveQueryCapabilities">
}

/** One listable entity's query capabilities, where they came from, and the checks they let run. */
export interface QueryCatalog {
	entity: string
	source: Caps["source"]
	filterable: Caps["filterable"]
	sortable: Caps["sortable"]
	searchable: string[]
	selectable: string[]
	operators?: Caps["operators"]
	operatorsByType?: Caps["operatorsByType"]
	aliases: Caps["aliases"]
	identityFilter?: string
	emptyIn?: Caps["emptyIn"]
	maxInValues?: number
	maxFilterConditions?: number
	searchModes?: string[]
	searchEmpty?: Caps["searchEmpty"]
	sort?: Caps["sort"]
	select?: Caps["select"]
	harvest: string[]
	hook: boolean
	checks: string[]
	/** A declared template, described; absent for a named or inferred grammar. */
	grammar?: string
	/** A declared sort template, described. */
	sortGrammar?: string
}

/** The capabilities a list was given by name in config rather than declared inline. */
function harvested(caps: Caps): string[] {
	return [
		caps.filterableFrom === undefined ? "" : "filterableFrom",
		caps.sortableFrom === undefined ? "" : "sortableFrom",
		caps.searchableFrom === undefined ? "" : "searchableFrom",
		caps.selectableFrom === undefined ? "" : "selectableFrom",
	].filter(Boolean)
}

/** The capabilities that are there only when declared, in the order the catalog lists them. */
function declaredLimits(caps: Caps): Partial<QueryCatalog> {
	return {
		...(caps.operators === undefined ? {} : { operators: caps.operators }),
		...(caps.operatorsByType === undefined ? {} : { operatorsByType: caps.operatorsByType }),
		...(caps.identityFilter === undefined ? {} : { identityFilter: caps.identityFilter }),
		...(caps.emptyIn === undefined ? {} : { emptyIn: caps.emptyIn }),
		...(caps.maxInValues === undefined ? {} : { maxInValues: caps.maxInValues }),
		...(caps.maxFilterConditions === undefined ? {} : { maxFilterConditions: caps.maxFilterConditions }),
		...(caps.searchModes === undefined ? {} : { searchModes: caps.searchModes }),
		...(caps.searchEmpty === undefined ? {} : { searchEmpty: caps.searchEmpty }),
		...(caps.sort === undefined ? {} : { sort: caps.sort }),
		...(caps.select === undefined ? {} : { select: caps.select }),
	}
}

/** One entity's catalog row: from its list operation and capabilities, with its name and hook as given. */
function catalogRow(
	listOp: OperationModel,
	caps: Caps,
	{ entity, hook }: Pick<QueryCatalog, "entity" | "hook">,
): QueryCatalog {
	const { filterGrammar, sortSpec } = listOp.conventions
	return {
		aliases: caps.aliases,
		checks: catalogCheckPreview(caps, listOp, caps.source),
		...(filterGrammar === undefined ? {} : { grammar: describeFilterGrammar(filterGrammar) }),
		...(sortSpec === undefined ? {} : { sortGrammar: describeSortGrammar(sortSpec) }),
		entity,
		filterable: caps.filterable,
		harvest: harvested(caps),
		hook,
		searchable: caps.searchable,
		selectable: caps.selectable,
		sortable: caps.sortable,
		source: caps.source,
		...declaredLimits(caps),
	}
}

/** Per listable entity, the query capabilities document and config together give its list. */
export function entityQueryCatalogs(
	model: SpecModel,
	config?: CatalogConfig,
): { catalogs: QueryCatalog[]; unknownEntities: string[] } {
	const unknownEntities = Object.keys(config?.entities ?? {}).filter((name) => !model.entities.has(name))
	const hook = config?.hooks?.resolveQueryCapabilities !== undefined
	const catalogs: QueryCatalog[] = []
	for (const entity of sortedEntities(model)) {
		if (entity.list === undefined) continue
		const listOp = listOperation(model, entity.list)
		const entityQuery = config?.entities?.[entity.name]?.query
		const caps = mergeQueryCapabilities({
			itemSchema: listOp.collection?.itemSchema ?? null,
			tag: listOp.query,
			...(config?.query === undefined ? {} : { global: config.query }),
			...(entityQuery === undefined ? {} : { entity: entityQuery }),
		})
		catalogs.push(catalogRow(listOp, caps, { entity: entity.name, hook }))
	}
	return { catalogs, unknownEntities }
}
