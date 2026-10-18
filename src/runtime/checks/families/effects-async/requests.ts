import type { OperationModel } from "../../../../spec/graph.ts"
import type { ReadClient } from "../../../client.ts"
import type { CheckContext } from "../../core/context.ts"
import { sameTenantScope } from "../../isolation/scratch.ts"
import { requestSchemaOf, validBody } from "../../payloads/body.ts"

/** The context a multi-operation check uses for one subject: its findings land on that operation. */
export function forOperation<C extends ReadClient>(ctx: CheckContext<C>, op: OperationModel): CheckContext<C> {
	return { ...ctx, findings: ctx.findings.attributed([op.operationId]) }
}

/** Invite bodies must carry the peer's `inviteAs`, never a generated email. */
export function bodyForOp(ctx: CheckContext, op: OperationModel): Record<string, unknown> {
	const body = validBody(ctx, requestSchemaOf(ctx, op) ?? {})
	const spec = op.invite ?? ctx.invite
	if (spec === null || spec === undefined) return body
	const owner = ctx.actors[0]
	const delegate =
		ctx.actors.find(
			(actor) =>
				actor !== owner &&
				actor.inviteAs !== undefined &&
				owner !== undefined &&
				!sameTenantScope(actor.roots, owner.roots),
		) ?? ctx.actors.find((actor) => actor !== owner && actor.inviteAs !== undefined)
	if (delegate?.inviteAs !== undefined) body[spec.granteeField] = delegate.inviteAs
	return body
}

export function subject(entity: string, operationId: string, fixture?: string): string {
	if (fixture === undefined) return entity
	return `${operationId} · ${fixture}`
}
