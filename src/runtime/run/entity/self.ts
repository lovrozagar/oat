import type { EntityModel } from "../../../spec/graph/types.ts"
import { runSelfIdentity } from "../../self/identity.ts"
import { SELF_CHECK_ID, selfOperationIds } from "../../self/operations.ts"
import { guardedClient } from "../../own-record.ts"
import type { RunContext } from "../context.ts"
import { ownRecordsOf } from "../own-records.ts"
import { graded, startedTest } from "./direct.ts"

/** An entity that is the caller: nothing to list, and register is not a create. */
export async function selfIdentity(ctx: RunContext, entity: EntityModel): Promise<void> {
	const { principals, client, findings, model, nonce, seed, hooks } = ctx
	startedTest(ctx, entity, SELF_CHECK_ID)
	const ownRecords = ownRecordsOf(ctx)
	const outcome = await runSelfIdentity({
		client: guardedClient(client, ownRecords, model),
		entity,
		findings,
		model,
		nonce,
		ownRecords,
		principal: principals.alpha.id,
		...(hooks.resolveInput === undefined ? {} : { resolveInput: hooks.resolveInput }),
		seed,
	})
	graded(ctx, selfOperationIds(entity, model), SELF_CHECK_ID, outcome)
}
