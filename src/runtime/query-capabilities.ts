/**
 * Live resolution of the filter catalog: harvest `filterableFrom`, then the hook.
 *
 * Merge of tag + config is pure and lives in `spec/query-capabilities`. This file talks HTTP.
 */

import type { QueryCapabilitiesRequest } from "../config/types/hooks.ts"
import type { QueryCapability } from "../spec/extensions/query-tag.ts"
import { parseRouteRef } from "../spec/routes.ts"
import type { OperationModel, SpecModel } from "../spec/graph/types.ts"
import type { FilterableField, QueryCapabilities } from "../config/types/query.ts"
import type { EffectiveQueryCapabilities } from "../spec/query/effective.ts"
import { applyHarvest } from "../spec/query/harvest.ts"
import { applyHook } from "../spec/query/hook.ts"
import { readJsonPathList } from "../spec/query/json-path.ts"
import { emptyCapabilities, mergeQueryCapabilities } from "../spec/query/merge.ts"
import type { Client } from "../client/client.ts"
import { fillPath } from "./fill-path.ts"

export async function resolveEntityCapabilities(input: {
	tag: QueryCapability | null
	itemSchema?: Record<string, unknown> | null
	global?: QueryCapabilities
	entity?: QueryCapabilities
	hook?: (request: QueryCapabilitiesRequest) => Promise<FilterableField[] | Partial<QueryCapabilities> | null>
	entityName: string
	scope: Record<string, string>
	model: SpecModel
	client: Client
	auth: () => Record<string, string>
}): Promise<EffectiveQueryCapabilities> {
	let caps = mergeQueryCapabilities({
		tag: input.tag,
		...(input.global === undefined ? {} : { global: input.global }),
		...(input.entity === undefined ? {} : { entity: input.entity }),
		...(input.itemSchema === undefined ? {} : { itemSchema: input.itemSchema }),
	})

	const get = async (operationId: string, scope = input.scope): Promise<unknown> => {
		const op = resolveHarvestOp(input.model, operationId)
		if (op === undefined) {
			throw new Error(`oat: harvest/get target "${operationId}" is not in the document`)
		}
		const exchange = await input.client.request(op.method, fillPath(op.path, scope), {
			headers: input.auth(),
			operationId: op.operationId,
		})
		return exchange.responseBody
	}

	const harvest = async (
		from: NonNullable<EffectiveQueryCapabilities["filterableFrom"]>,
		axis: "filterable" | "sortable" | "searchable" | "selectable",
	): Promise<void> => {
		const target = from.operationId ?? from.route
		if (target === undefined) return
		const body = await get(target)
		const names = readJsonPathList(body, from.path).filter((value): value is string => typeof value === "string")
		const types =
			from.typePath === undefined
				? []
				: readJsonPathList(body, from.typePath).map((value) => (typeof value === "string" ? value : undefined))
		caps = applyHarvest(caps, names, types, axis)
	}

	if (caps.filterableFrom !== undefined) await harvest(caps.filterableFrom, "filterable")
	if (caps.sortableFrom !== undefined) await harvest(caps.sortableFrom, "sortable")
	if (caps.searchableFrom !== undefined) await harvest(caps.searchableFrom, "searchable")
	if (caps.selectableFrom !== undefined) await harvest(caps.selectableFrom, "selectable")

	if (input.hook !== undefined) {
		const result = await input.hook({ entity: input.entityName, get, scope: input.scope })
		caps = applyHook(caps, result)
	}

	return caps
}

export function capabilitiesFromTag(tag: QueryCapability | null): EffectiveQueryCapabilities {
	if (tag === null) return emptyCapabilities()
	return mergeQueryCapabilities({ tag })
}

function resolveHarvestOp(model: SpecModel, target: string): OperationModel | undefined {
	const byId = model.byOperationId.get(target)
	if (byId !== undefined) return byId
	const parsed = parseRouteRef(target.startsWith("/") ? `GET ${target}` : target)
	if (parsed === null) return undefined
	return model.byRoute.get(`${parsed.method} ${parsed.path}`)
}
