import type { OperationCheck } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationWriteContext } from "../../core/operation-context.ts"
import { isUntested } from "../../core/operation.ts"
import { isRefused, type Lifecycle, lifecyclePlan, type SchemeOutcome, settle } from "./lifecycle.ts"

/**
 * A revoked credential stops working. For each scheme whose recipe declares a revoke, anchored on
 * that revoke operation, the check acquires a dedicated credential (never the principal's own),
 * proves it on one read, revokes it through the declared path, and sends it to the same read again,
 * which must now refuse it with 401 or 403.
 */
export const revokedCredentialRefused: OperationCheck<Lifecycle[]> = defineCheck<Lifecycle[]>({
	id: "auth.revoked-credential-refused",
	mutates: true,
	mutatesCredentials: true,
	needs: "a recipe that declares a revoke, and a GET the credential authenticates",
	plan: (ctx) => lifecyclePlan(ctx, "revoke"),
	subject: "operation",
	async run(ctx, planned) {
		const outcomes: SchemeOutcome[] = []
		for (const lifecycle of planned) outcomes.push(await revokeAndProbe(ctx, lifecycle))
		return settle(outcomes)
	},
})

const CHECK = "auth.revoked-credential-refused"

async function revokeAndProbe(ctx: OperationWriteContext, { actor, route, scheme }: Lifecycle): Promise<SchemeOutcome> {
	const { operation, path, scopes } = route
	const reads = operation.operationId
	const dedicated = await ctx.probe.dedicated({ principal: actor, scheme, scopes })
	if (isUntested(dedicated)) return { untested: `${scheme}: ${dedicated.untested}` }
	const { revoke } = dedicated
	if (revoke === undefined) return { untested: `${scheme}: the dedicated credential has no declared revoke` }
	const as = { principal: dedicated.actor.principal, scheme }
	const query = operation.requiredQuery
	const before = await ctx.client.get(path, { as, operationId: reads, query })
	if (before.status >= 300) {
		const reason = `a fresh ${scheme} credential was refused (${before.status}) on ${reads} before its revoke`
		return ctx.findings.unresolved(CHECK, ctx.subject, reason)
	}
	await revoke()
	const after = await ctx.client.get(path, { as, operationId: reads, probe: true, query })
	if (isRefused(after.status)) return { kind: "asserted" }
	if (after.status >= 300) {
		const reason = `after its revoke, a ${scheme} credential drew ${after.status} on ${reads}, neither a refusal nor a success`
		return ctx.findings.unresolved(CHECK, ctx.subject, reason)
	}
	return ctx.findings.security(CHECK, ctx.subject, {
		detail:
			`${actor}'s ${scheme} credential, issued for this probe alone and revoked through ` +
			`${ctx.subject}, was still accepted: ${reads} answered ${after.status}. A credential that ` +
			"survives its revoke cannot be taken back from whoever holds it.",
		evidence: [before, after],
		summary: `a revoked ${scheme} credential still authenticates`,
	})
}
