import { messageOf } from "../../../errors/message.ts"
import type { EntityModel } from "../../../spec/graph/types.ts"
import { rootReadIds, ROOT_READ_CHECK_ID, runRootRead } from "../../root-read.ts"
import type { Outcome } from "../../finding.ts"
import type { RunContext } from "../context.ts"
import { unresolvedBy } from "./run-check.ts"
import { graded, startedTest } from "./direct.ts"

/** An entity whose path id is the caller's root: nothing to create, its read is the whole test. */
export async function rootRead(ctx: RunContext, entity: EntityModel): Promise<void> {
	const { principals, client, findings, model } = ctx
	startedTest(ctx, entity, ROOT_READ_CHECK_ID)
	const ids = rootReadIds(entity)
	let outcome: Outcome
	try {
		outcome = await runRootRead({
			client,
			entity,
			findings,
			model,
			principal: principals.alpha.id,
			roots: { ...principals.alpha.scope },
		})
	} catch (error) {
		outcome = await stoppedBy(ctx, entity.name, ids, error)
	}
	graded(ctx, ids, ROOT_READ_CHECK_ID, outcome)
}

/* An error stops the root read as it stops any check: a stand-down where it has a cause, else a gap. */
async function stoppedBy(ctx: RunContext, entity: string, ids: string[], error: unknown): Promise<Outcome> {
	/* A stop is reported under its own id (the fence, a blocked credential), never the check's. */
	const attributed = ctx.findings.attributed(ids)
	const stopped = { attributed, checkId: ROOT_READ_CHECK_ID, ctx, entity }
	const reason = await unresolvedBy(stopped, error)
	if (reason !== undefined) return { kind: "unresolved", reason }
	return attributed.gap(ROOT_READ_CHECK_ID, entity, {
		summary: `check "${ROOT_READ_CHECK_ID}" could not complete`,
		detail: messageOf(error),
	})
}
