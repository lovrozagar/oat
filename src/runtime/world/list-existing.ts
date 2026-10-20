import type { Client } from "../../client/client.ts"
import { largestPageQuery } from "../../spec/graph/paging.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { FencedError } from "../fence.ts"
import { fillPath } from "../fill-path.ts"
import { type Record_, recordsFromList } from "./records.ts"

/** The list route and what it needs: the operation, its model, and the path values to fill it with. */
export interface ListRoute {
	listOp: OperationModel
	model: SpecModel
	values: Record<string, string>
}

/** Same-tenant records the list route already returns. Empty when the route cannot be resolved. */
export async function listExisting(route: ListRoute, client: Client, principal: string): Promise<Record_[]> {
	const { listOp, model, values } = route
	for (const param of listOp.pathParams) {
		if (values[param] === undefined) return []
	}
	try {
		const exchange = await client.get(fillPath(listOp.path, values), {
			as: { principal },
			operationId: listOp.operationId,
			query: largestPageQuery(model, listOp),
		})
		if (exchange.status >= 300) return []
		return recordsFromList(exchange.responseBody, listOp.collection?.key ?? null)
	} catch (error) {
		/* A fenced read is not an empty collection. */
		if (error instanceof FencedError) throw error
		return []
	}
}
