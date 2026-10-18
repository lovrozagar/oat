import type { Client } from "../../../../client/client.ts"
import { FencedError } from "../../../fence.ts"
import { fillPath } from "../../../fill-path.ts"
import { type ProvenId, returnedId } from "../../../proven-id.ts"
import { confirmSubmitted } from "../../../world/confirm.ts"
import { type Record_ } from "../../../world/records.ts"
import type { CheckContext } from "../../core/context.ts"
import { readRecord } from "../../isolation/scratch.ts"
import { itemParamFor } from "../../planning/subjects.ts"

/* A declared `x-entity.recordPath` that names nothing in the answer: there is no record to compare. */
export const NO_RECORD = "the answer holds no record where x-entity.recordPath says it is"

/**
 * The id an acknowledgement-only create made, proven by the entity's read under the id it was
 * sent (see `confirmSubmitted`). The read is the one this check context may call, or none.
 */
export async function confirmedIdentity(
	ctx: CheckContext,
	client: Pick<Client, "get">,
	sent: unknown,
	ignore: readonly string[] = [],
): Promise<{ id: ProvenId; record: Record_ } | undefined> {
	const record = await confirmSubmitted({
		client,
		entity: ctx.entityName,
		headers: ctx.auth(),
		identity: ctx.identity,
		ignore,
		model: ctx.model,
		readable: (op) => op.operationId === ctx.readOp?.operationId,
		scope: ctx.scope,
		sent,
	})
	const id = record === null ? undefined : returnedId(record, ctx.identity)
	return record !== null && id !== undefined ? { id, record } : undefined
}

/** Item GET when available — list projections can disagree with stored unique values. */
export async function liveRecord(ctx: CheckContext, id: string | undefined): Promise<Record_ | undefined> {
	if (id === undefined || ctx.readOp === undefined) return undefined
	try {
		const exchange = await ctx.client.get(fillPath(ctx.readOp.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
			headers: ctx.auth(),
		})
		if (exchange.status >= 300 || exchange.responseBody === null || typeof exchange.responseBody !== "object") {
			return undefined
		}
		return readRecord(ctx.readOp, exchange)
	} catch (error) {
		/* A fenced read is not "no record": the caller must hear that it could not ask. */
		if (error instanceof FencedError) throw error
		return undefined
	}
}
