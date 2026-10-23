import type { OperationCheck } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationWriteContext } from "../../core/operation-context.ts"
import { isUntested } from "../../core/operation.ts"
import { type Lifecycle, lifecyclePlan, type SchemeOutcome, settle } from "./lifecycle.ts"

/**
 * A refresh token works once. For each scheme whose recipe declares a refresh, anchored on that
 * refresh operation, the check acquires a dedicated session (never the principal's own), rotates it,
 * proves the rotated session on one read, then replays the refresh token the rotation spent. The
 * replay must fail: a stolen refresh token that keeps refreshing is a session that never ends.
 */
export const refreshReuseRefused: OperationCheck<Lifecycle[]> = defineCheck<Lifecycle[]>({
	id: "auth.refresh-reuse-refused",
	mutates: true,
	mutatesCredentials: true,
	needs: "a recipe that declares a refresh, and a GET the credential authenticates",
	plan: (ctx) => lifecyclePlan(ctx, "refresh"),
	subject: "operation",
	async run(ctx, planned) {
		const outcomes: SchemeOutcome[] = []
		for (const lifecycle of planned) outcomes.push(await rotateAndReplay(ctx, lifecycle))
		return settle(outcomes)
	},
})

const CHECK = "auth.refresh-reuse-refused"

async function rotateAndReplay(
	ctx: OperationWriteContext,
	{ actor, route, scheme }: Lifecycle,
): Promise<SchemeOutcome> {
	const { operation, path, scopes } = route
	const reads = operation.operationId
	const dedicated = await ctx.probe.dedicated({ principal: actor, scheme, scopes })
	if (isUntested(dedicated)) return { untested: `${scheme}: ${dedicated.untested}` }
	if (dedicated.rotate === undefined) return { untested: `${scheme}: the dedicated credential has no declared refresh` }
	const rotation = await dedicated.rotate()
	const as = { principal: dedicated.actor.principal, scheme }
	const proven = await ctx.client.get(path, { as, operationId: reads, query: operation.requiredQuery })
	if (proven.status >= 300) {
		const reason =
			`the rotated ${scheme} session was refused (${proven.status}) on ${reads}, ` +
			"so a refused reuse would prove nothing"
		return ctx.findings.unresolved(CHECK, ctx.subject, reason)
	}
	const replayed = await rotation.replay()
	if (!replayed.accepted) return { kind: "asserted" }
	return ctx.findings.security(CHECK, ctx.subject, {
		detail:
			`${actor}'s ${scheme} session, issued for this probe alone, was rotated through ` +
			`${ctx.subject} and proven on ${reads}; the refresh token that rotation spent then refreshed ` +
			"again. Reuse of a rotated refresh token must fail, and should revoke the whole session.",
		evidence: [proven, ...ctx.client.exchangesFor(ctx.subject).slice(-1)],
		summary: `a rotated ${scheme} refresh token refreshes again`,
	})
}
