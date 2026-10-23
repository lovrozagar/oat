import type { EffectiveQueryCapabilities } from "../../../spec/query/effective.ts"
import type { QueryCapability } from "../../../spec/extensions/query-tag.ts"
import { filterIsGuess, queryOver, sendableCapabilities, type Withheld } from "../../../spec/query/sendable.ts"
import { resolveEntityCapabilities } from "../../query-capabilities.ts"
import { emptyCapabilities } from "../../../spec/query/merge.ts"
import type { EntityRun } from "./state.ts"

/** What the entity's list can filter, search, select and sort by, and the query the checks read. */
export interface EntityQuery {
	/** Cut to what the list's declared parameters can carry; see `sendableCapabilities`. */
	capabilities: EffectiveQueryCapabilities
	/** The list's query, narrowed to what the capabilities resolved; `null` with no query tag. */
	query: QueryCapability | null
	/** What the resolved capabilities held that no declared parameter carries. */
	withheld: Withheld[]
}

/**
 * Resolves the list's query capabilities: the tag, then config, then the hook, then probes. An
 * entity with no list has none to query.
 */
export async function queryOf(run: EntityRun, scope: Record<string, string>): Promise<EntityQuery> {
	const { ctx, entity, listOp } = run
	if (listOp === undefined) return { capabilities: emptyCapabilities(), query: null, withheld: [] }
	const { options, hooks } = ctx
	const configured = options.entities?.[entity.name]?.query
	const sources = {
		tag: listOp.query,
		...(options.query === undefined ? {} : { global: options.query }),
		...(configured === undefined ? {} : { entity: configured }),
	}
	const resolved = await resolveEntityCapabilities({
		...sources,
		client: ctx.client,
		entityName: entity.name,
		itemSchema: listOp.collection?.itemSchema ?? null,
		model: ctx.model,
		principal: ctx.principals.alpha.id,
		scope,
		...(hooks.resolveQueryCapabilities === undefined ? {} : { hook: hooks.resolveQueryCapabilities }),
	})
	const { capabilities, withheld } = sendableCapabilities(resolved, listOp, filterIsGuess(sources, resolved))
	return { capabilities, query: queryOver(listOp.query, capabilities), withheld }
}
