import type { OperationModel } from "../../../spec/graph/types.ts"
import type { Exchange } from "../../exchange.ts"
import { fillPath } from "../../fill-path.ts"
import { type ClientIdCreate, createWithClientId } from "../../world/client-identity.ts"
import type { WriteContext } from "../core/context.ts"
import { encodeOpBody, validBody } from "./body.ts"
import { clientIdentityOf } from "./identity.ts"

/**
 * A create meant to succeed, from `validBody`, sent as `principal`. A client-chosen identity oat never
 * saw can still be taken, by another tenant's record in an id space that spans tenants, so a 409 on
 * such a body is sent again under a fresh one (`createWithClientId`), and `exhausted` says why when
 * every attempt was refused. A body with no identity of its own gets its 409 back: that conflict is
 * about something else, and another body would not cure it.
 */
export async function createFresh(
	ctx: WriteContext,
	createOp: OperationModel,
	schema: Record<string, unknown>,
	principal: string,
): Promise<ClientIdCreate> {
	const send = async (body: Record<string, unknown>): Promise<Exchange> =>
		ctx.client.request("POST", fillPath(createOp.path, ctx.scope), {
			...(await encodeOpBody(ctx, createOp, body)),
			as: { principal },
			operationId: createOp.operationId,
		})
	return createWithClientId(validBody(ctx, schema), send, clientIdentityOf(ctx, schema, `f${ctx.nonce ?? ""}`))
}
