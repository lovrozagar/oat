import type { EntityModel } from "../../../spec/graph/types.ts"
import { rootReadIds, ROOT_READ_CHECK_ID, runRootRead } from "../../root-read.ts"
import type { RunContext } from "../context.ts"
import { graded, startedTest } from "./direct.ts"

/** An entity whose path id is the caller's root: nothing to create, its read is the whole test. */
export async function rootRead(ctx: RunContext, entity: EntityModel): Promise<void> {
	const { principals, client, findings, model, options } = ctx
	startedTest(ctx, entity, ROOT_READ_CHECK_ID)
	const outcome = await runRootRead({
		auth: principals.alpha.headers,
		client,
		entity,
		findings,
		model,
		roots: { ...options.roots, ...principals.alpha.roots },
	})
	graded(ctx, rootReadIds(entity), ROOT_READ_CHECK_ID, outcome)
}
