import type { OperationModel } from "../../../spec/graph.ts"
import type { Exchange } from "../../client.ts"
import { fillPath } from "../../fill-path.ts"
import type { WriteContext } from "../core/context.ts"
import { encodeOpBody, validBody } from "./body.ts"
import { choosesIdentity } from "./identity.ts"

/* Identities a create tries before its 409 is the answer. */
const FRESH_IDENTITY_TRIES = 3

/**
 * A create meant to succeed, from `validBody`. A client-chosen identity oat never saw can still be
 * taken, by another tenant's record in an id space that spans tenants, so a 409 on such a body is
 * sent again under another identity, a few times. A body with no identity of its own gets its 409
 * back: that conflict is about something else, and another body would not cure it.
 */
export async function createFresh(
	ctx: WriteContext,
	createOp: OperationModel,
	schema: Record<string, unknown>,
	headers: Record<string, string>,
): Promise<{ exchange: Exchange; sent: Record<string, unknown> }> {
	for (let attempt = 1; ; attempt++) {
		const sent = validBody(ctx, schema)
		const exchange = await ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, sent)),
			headers,
			operationId: createOp.operationId,
		})
		if (exchange.status !== 409 || !choosesIdentity(ctx, schema) || attempt >= FRESH_IDENTITY_TRIES) {
			return { exchange, sent }
		}
	}
}
