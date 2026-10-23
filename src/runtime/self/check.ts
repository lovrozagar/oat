import type { EntityModel, SpecModel } from "../../spec/graph/types.ts"
import type { Check } from "../checks/core/check.ts"
import type { CheckContext, WriteContext } from "../checks/core/context.ts"
import type { Outcome } from "../finding.ts"
import { runSelfIdentity } from "./identity.ts"
import { entityIsSelf, SELF_CHECK_ID, selfOperationIds } from "./operations.ts"

export const selfIdentityCheck: Check<void> = {
	id: SELF_CHECK_ID,
	mutates: true as const,
	needs: "x-entity.identity: self, and a read or an update",
	plan(ctx: CheckContext) {
		const entity = ctx.model.entities.get(ctx.entityName)
		if (entity === undefined || !entityIsSelf(entity)) {
			return { ok: false as const, needs: "x-entity.identity: self, and a read or an update" }
		}
		return { ok: true as const, value: undefined }
	},
	async run(ctx: WriteContext): Promise<Outcome> {
		return runSelfIdentity({
			principal: ctx.actor.id,
			client: ctx.client,
			entity: ctx.model.entities.get(ctx.entityName) as EntityModel,
			findings: ctx.findings,
			model: ctx.model,
			...(ctx.ownRecords === undefined ? {} : { ownRecords: ctx.ownRecords }),
		})
	},
	subjects: (entity: EntityModel, model?: SpecModel): string[] => selfOperationIds(entity, model),
}
