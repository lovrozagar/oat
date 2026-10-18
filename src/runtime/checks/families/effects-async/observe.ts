import type { OperationModel } from "../../../../spec/graph.ts"
import type { Exchange } from "../../../client.ts"
import { canFillPath } from "../../../effects.ts"
import { fillPath } from "../../../fill-path.ts"
import type { Record_ } from "../../../world.ts"
import type { CheckContext } from "../../core/context.ts"
import { forList, ids } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"

/**
 * The instance an action binds from, as it is now. An earlier action — or this one's x-before —
 * may have changed it since it was seeded: a reorder bound to every column the seed held refuses
 * the column added since. The fresh read leads; the seeded records stay behind it for whatever the
 * read does not hold.
 */
export async function currentRecords(ctx: CheckContext, scope: Record<string, string>): Promise<readonly Record_[]> {
	const readOp = ctx.readOp
	if (readOp === undefined || !canFillPath(readOp.path, scope)) return ctx.records
	const read = await ctx.client.get(fillPath(readOp.path, scope), {
		headers: ctx.auth(),
		operationId: readOp.operationId,
	})
	const body = read.responseBody
	if (read.status >= 300 || body === null || typeof body !== "object" || Array.isArray(body)) return ctx.records
	return [body as Record_, ...ctx.records]
}

export type Observation =
	| { status: "unfillable" }
	| { status: "error"; exchange: Exchange; reason: string }
	| { status: "ok"; ids: string[]; exchange: Exchange }

export function listOpFor(ctx: CheckContext, entityName: string): OperationModel | undefined {
	const listId = ctx.model.entities.get(entityName)?.list
	return listId === undefined ? undefined : ctx.model.byOperationId.get(listId)
}

export async function observe(
	ctx: CheckContext,
	listOp: OperationModel,
	scope: Record<string, string> = ctx.scope,
): Promise<Observation> {
	if (!canFillPath(listOp.path, scope)) return { status: "unfillable" }
	/* The whole collection: an effect that adds one record to a collection larger than a page
	 * is invisible on the first page, and reads as an effect that never happened. */
	const view = forList(ctx, listOp)
	const read = await readSet(view, {}, { fresh: true, scope })
	if (!read.complete) return { exchange: read.last.exchange, reason: read.reason, status: "error" }
	return { exchange: read.last.exchange, ids: ids(read.items, view.identity), status: "ok" }
}
