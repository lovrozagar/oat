import { createTracker } from "../create-tracker.ts"
import type { Disposable, TeardownReport } from "../teardown/types.ts"
import type { RunContext } from "./context.ts"
import { errorText } from "./errors.ts"
import { messageOf } from "../../errors/message.ts"
import type { RunFindingId } from "../check-ids.ts"
import { createdByRun } from "./principals.ts"

/**
 * Every create a configured principal sends is ledgered as it, whichever view sent it; a probe's POST
 * that carried no principal's credential and was let through, as the first principal's.
 */
export function trackCreates(ctx: RunContext): void {
	const { client, ledger, model, principals, state, exclusion } = ctx
	const tracker = createTracker({
		client,
		ledger,
		model,
		onRecorded: (entity, id) => state.takenByEntity.get(entity)?.add(id),
		owners: new Map(
			principals.all.map((principal) => [
				principal.id,
				{ owner: principals.ownerOf(principal), roots: { ...principal.scope } },
			]),
		),
		readable: exclusion.readable,
		/* A probe write a backend let through with no credential is applied all the same: the first
		 * principal reads it back and removes it, or teardown reports it as a record that may remain. */
		stranger: { owner: principals.ownerOf(principals.alpha), roots: { ...principals.alpha.scope } },
	})
	client.setAfterExchange(tracker.observe)
}

/**
 * Removes what the run created so far. After every check has run, never per case: a check may
 * legitimately depend on records another one created, and tearing down early turns that into a
 * phantom defect. Runs again after the scenarios and contract calls, for what they created.
 */
export async function unwind(ctx: RunContext): Promise<void> {
	const { ledger, progress, options, findings } = ctx
	progress.check = undefined
	progress.tick({ message: `${ledger.size} record(s)`, phase: "teardown", requests: progress.requests })
	if (options.keepFixtures === true || ledger.size === 0) return
	/* What this unwind takes: when it throws, none of it is shown gone. */
	const pending = [...ledger.entries()]
	try {
		const report = await ledger.unwind(ctx.model, ctx.client.view({ purpose: "teardown" }), {
			fallbacks: ctx.principals.fallbackDeleters,
			options: {
				onItem: (done, total, item) => {
					if (done % 25 !== 0 && done !== total) return
					progress.tick({
						entity: item.entity,
						message: `${done}/${total} ${item.entity} ${item.id}`,
						phase: "teardown",
						requests: progress.requests,
					})
				},
				verify: options.teardown?.verify !== false,
				...(ctx.hooks.verifyRemoved === undefined ? {} : { verifyRemoved: ctx.hooks.verifyRemoved }),
			},
		})
		noteHookErrors(ctx, report.verifyHookErrors ?? [])
		ctx.state.teardown = merged(ctx.state.teardown, report)
	} catch (error) {
		findings.blocked("world.teardown" satisfies RunFindingId, "run", {
			summary: `teardown stopped on an unexpected error with ${ledger.size} record(s) ledgered`,
			cause: errorText(error),
		})
		ctx.state.teardown = merged(ctx.state.teardown, unshown(pending, messageOf(error)))
	}
}

/* Records an unwind that threw was to remove: each may remain, so each is a leftover. */
function unshown(pending: readonly Disposable[], why: string): TeardownReport {
	const reason = `teardown stopped on an unexpected error: ${why}`
	return {
		failed: pending.map(({ entity, id, owner }) => ({ entity, id, principal: owner.id, reason })),
		records: pending.map(({ entity, id, owner }) => ({ entity, id, principal: owner.id, removed: false })),
		removed: 0,
		unidentified: [],
		unsupported: [],
	}
}

/* Once per run, however many calls threw or unwinds ran. */
function noteHookErrors({ state, findings }: RunContext, errors: readonly string[]): void {
	if (errors.length === 0 || state.verifyHookFailed) return
	state.verifyHookFailed = true
	findings.gap("teardown.verify-hook" satisfies RunFindingId, "teardown", {
		summary: "hooks.verifyRemoved threw",
		detail: `${errors.length} call(s) threw, so those records keep teardown's own verdict: ${errors[0]}`,
	})
}

/** Two teardown reports as one: what each removed, and every record each could not. */
export function merged(before: TeardownReport | null, report: TeardownReport): TeardownReport {
	return {
		failed: [...(before?.failed ?? []), ...report.failed],
		records: [...(before?.records ?? []), ...report.records],
		removed: (before?.removed ?? 0) + report.removed,
		unidentified: [],
		unsupported: [...new Set([...(before?.unsupported ?? []), ...report.unsupported])],
	}
}

/** Records of an entity no delete reaches stay behind; the report says which, and how to fix it. */
export function reportUnremovable({ state, findings }: RunContext): void {
	const unremovable = state.teardown?.unsupported ?? []
	if (unremovable.length === 0) return
	const names = unremovable.join(", ")
	findings.gap("world.teardown" satisfies RunFindingId, names, {
		summary: "records created during the run could not be removed",
		detail:
			`no delete operation is reachable for ${names}, so this run left ` +
			"fixtures behind. Declare x-cleanup to name the route that removes them.",
	})
}

/**
 * Revokes every credential the run minted, once its records are gone: a minted key is a fixture
 * too. A key superseded by a re-mint is revoked as well. Each revoke that fails is a record the run
 * could not remove. A secondary origin's run leaves this to the primary, whose store it shares.
 */
export async function revokeCredentials({ options, store, state }: RunContext): Promise<void> {
	if (options.sharedCredentials !== undefined) return
	recordUnrevoked(state, await store.revokeAll())
}

/**
 * The run's very last calls: each configured principal's own login session, ended by the login's
 * declared `revoke`, after teardownPrincipal is done with it. A principal the run made is gone with
 * its account already. With no declared revoke nothing is sent, and `--keep-credentials` keeps the
 * sessions for the commands that replay them. A secondary origin's run leaves it to the primary.
 */
export async function revokeSessions(ctx: RunContext): Promise<void> {
	const { options, store, state } = ctx
	if (options.keepCredentials === true || options.sharedCredentials !== undefined) return
	recordUnrevoked(state, await store.revokeSessions((principal) => !createdByRun(ctx, principal)))
}

/* Each revoke that failed is a credential the run could not remove. */
function recordUnrevoked(
	state: RunContext["state"],
	failures: ReadonlyArray<{ principal: string; scheme: string; reason: string }>,
): void {
	if (failures.length === 0) return
	const failed = failures.map(({ principal, reason, scheme }) => ({
		entity: "credential",
		id: `${principal}/${scheme}`,
		principal,
		reason,
	}))
	state.teardown = merged(state.teardown, { failed, records: [], removed: 0, unidentified: [], unsupported: [] })
}
