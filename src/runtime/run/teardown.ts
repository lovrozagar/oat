import { createTracker } from "../create-tracker.ts"
import type { TeardownReport } from "../teardown/types.ts"
import type { RunContext } from "./context.ts"
import { errorText } from "./errors.ts"
import { messageOf } from "../../errors/message.ts"
import type { RunFindingId } from "../check-ids.ts"

/** Every create a configured principal sends is ledgered as it, whichever view sent it. */
export function trackCreates(ctx: RunContext): void {
	const { client, ledger, model, options, principals, state, exclusion } = ctx
	const tracker = createTracker({
		client,
		ledger,
		model,
		onRecorded: (entity, id) => state.takenByEntity.get(entity)?.add(id),
		owners: new Map(
			principals.all.map((principal) => [
				principal.id,
				{ owner: principals.ownerOf(principal), roots: { ...options.roots, ...principal.roots } },
			]),
		),
		readable: exclusion.readable,
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

function merged(before: TeardownReport | null, report: TeardownReport): TeardownReport {
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
 * Removes principals the run provisioned.
 *
 * Where a flow registers a throwaway account, the account itself is a fixture — and usually the
 * only handle that can remove everything it created, since per-record deletes are owner-scoped
 * and the credential dies with the run. A secondary origin's run shares the primary's accounts and
 * leaves them to it.
 */
export async function teardownPrincipals({ options, hooks, findings, principals }: RunContext): Promise<void> {
	if (options.skipPrincipalTeardown === true) return
	const provisioned = principals.all.flatMap((principal) => {
		const address = principal.runtime?.address
		return principal.runtime === undefined || typeof address !== "string" || address === ""
			? []
			: [{ address, principal, runtime: principal.runtime }]
	})
	if (provisioned.length === 0) return
	const teardown = hooks.teardownPrincipal
	if (teardown === undefined) {
		const addresses = provisioned.map(({ address }) => address)
		findings.gap("world.teardown" satisfies RunFindingId, "principal", {
			summary: `${addresses.length} principal(s) provisioned by this run were not removed`,
			detail:
				`oat registered ${addresses.join(", ")} to run this test and has no way to delete them. ` +
				"Supply a teardownPrincipal hook, or these accounts accumulate on every run.",
		})
		return
	}
	for (const { address, principal, runtime } of provisioned) {
		try {
			await teardown(address, { credential: runtime.credential(), headers: principal.headers() })
		} catch (error) {
			findings.gap("world.teardown" satisfies RunFindingId, "principal", {
				summary: `could not remove provisioned principal ${address}`,
				detail: messageOf(error),
			})
		}
	}
}
