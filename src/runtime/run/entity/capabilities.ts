import type { EffectiveQueryCapabilities } from "../../../spec/query/effective.ts"
import type { QueryCapability } from "../../../spec/extensions/query-tag.ts"
import { resolveEntityCapabilities } from "../../query-capabilities.ts"
import type { EntityRun } from "./state.ts"

/** What the entity's list can filter, search, select and sort by, and the query the checks read. */
export interface EntityQuery {
	capabilities: EffectiveQueryCapabilities
	/** The list's query, narrowed to what the capabilities resolved; `null` with no query tag. */
	query: QueryCapability | null
}

/** Resolves the list's query capabilities: the tag, then config, then the hook, then probes. */
export async function queryOf(run: EntityRun, scope: Record<string, string>): Promise<EntityQuery> {
	const { ctx, entity, listOp } = run
	const { options, hooks } = ctx
	const configured = options.entities?.[entity.name]?.query
	const capabilities = await resolveEntityCapabilities({
		auth: ctx.principals.alpha.headers,
		client: ctx.client,
		entityName: entity.name,
		itemSchema: listOp.collection?.itemSchema ?? null,
		model: ctx.model,
		scope,
		tag: listOp.query,
		...(options.query === undefined ? {} : { global: options.query }),
		...(configured === undefined ? {} : { entity: configured }),
		...(hooks.resolveQueryCapabilities === undefined ? {} : { hook: hooks.resolveQueryCapabilities }),
	})
	const tag = listOp.query
	return {
		capabilities,
		query:
			tag === null
				? null
				: {
						...tag,
						filterable: capabilities.filterable.map((field) => field.field),
						searchable: capabilities.searchable,
						selectable: capabilities.selectable,
						sortable: capabilities.sortable.map((field) => field.field),
					},
	}
}
