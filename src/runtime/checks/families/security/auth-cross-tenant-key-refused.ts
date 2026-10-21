import type { Actor } from "../../core/context.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationContext } from "../../core/operation-context.ts"
import { andThen, cannot, type Plan, ready } from "../../core/plan.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { fillPath } from "../../../fill-path.ts"
import { noSecurityReason } from "../../../no-security.ts"
import { isRefused, type SchemeOutcome, settle, unlessUnsatisfied } from "./lifecycle.ts"
import { BY_VALIDATION, byValidation } from "./probing.ts"

/** The peer, the API-key schemes the operation takes alone, and its path under each tenant. */
interface CrossTenant {
	peer: Actor
	schemes: string[]
	/** The path under the actor's tenant, where the peer's key must be refused. */
	foreign: string
	/** The path under the peer's own tenant, where its key must work. */
	own: string
}

/**
 * An API key belongs to one tenant. On a GET under the actor's tenant that takes an API key alone,
 * the peer tenant's key (minted through the run's store like any credential, so teardown revokes it)
 * must be refused with 401, 403 or 404. Its acceptance in the peer's own tenant proves the refusal
 * was about the tenant, not a broken key.
 */
export const crossTenantKeyRefused = defineCheck<CrossTenant>({
	id: "auth.cross-tenant-key-refused",
	needs: "a peer tenant, and a tenant-scoped GET that takes an API key",
	plan: (ctx) => {
		const undeclared = noSecurityReason(ctx.operation)
		if (undeclared !== undefined) return cannot(undeclared)
		const { peer } = ctx
		if (peer === undefined) return cannot("a principal of another tenant")
		if (ctx.operation.method.toUpperCase() !== "GET") {
			return cannot(`a GET; ${ctx.operation.operationId} is probed by the write stage's checks`)
		}
		return andThen(keySchemes(ctx), (schemes) =>
			andThen(paths(ctx, peer), ({ foreign, own }) => ready({ foreign, own, peer, schemes })),
		)
	},
	subject: "operation",
	async run(ctx, planned) {
		const outcomes: SchemeOutcome[] = []
		for (const scheme of planned.schemes) {
			const label = `${planned.peer.id}'s ${scheme} key`
			outcomes.push(await unlessUnsatisfied(label, () => crossWith(ctx, { planned, scheme })))
		}
		return settle(outcomes)
	},
})

const CHECK = "auth.cross-tenant-key-refused"

/* The API-key schemes an alternative of the operation takes alone. */
function keySchemes(ctx: OperationContext): Plan<string[]> {
	const schemes = ctx.operation.security.alternatives.flatMap((set) => {
		const scheme = set.length === 1 ? set[0]?.scheme : undefined
		return scheme !== undefined && ctx.model.schemes.get(scheme)?.kind === "apiKey" ? [scheme] : []
	})
	return schemes.length > 0 ? ready([...new Set(schemes)]) : cannot("an alternative that takes an API key alone")
}

/* The operation's path under each tenant: both scopes fill every parameter, and differently. */
function paths(ctx: OperationContext, peer: Actor): Plan<{ foreign: string; own: string }> {
	const { pathParams, path } = ctx.operation
	const fills = (actor: Actor) => pathParams.every((name) => name in actor.scope)
	if (pathParams.length > 0 && fills(ctx.actor) && fills(peer)) {
		const foreign = fillPath(path, ctx.actor.scope)
		const own = fillPath(path, peer.scope)
		if (foreign !== own) return ready({ foreign, own })
	}
	return cannot("a path the actor's and the peer's scopes each fill, differently")
}

async function crossWith(
	ctx: OperationContext,
	{ planned, scheme }: { planned: CrossTenant; scheme: string },
): Promise<Outcome> {
	const { foreign, own, peer } = planned
	const { operationId, requiredQuery: query } = ctx.operation
	const as = { principal: peer.id, scheme }
	const key = `${peer.id}'s ${scheme} key`
	const tenant = String(ctx.actor.tenant)
	const crossed = await ctx.client.get(foreign, { as, operationId, probe: true, query })
	if (crossed.status < 300) {
		return ctx.findings.security(CHECK, ctx.subject, {
			detail:
				`${key} (tenant ${String(peer.tenant)}) was sent to ${operationId} under ${tenant}, ` +
				`${ctx.actor.id}'s tenant: ${operationId} answered ${crossed.status}. A key must work only ` +
				"in the tenant it was issued for.",
			evidence: [crossed],
			summary: `an ${scheme} key of one tenant is accepted in another`,
		})
	}
	if (byValidation(crossed.status)) {
		return ctx.findings.unresolved(
			CHECK,
			ctx.subject,
			`${key} drew ${crossed.status} under ${tenant}: ${BY_VALIDATION}`,
		)
	}
	if (!isRefused(crossed.status) && crossed.status !== 404) {
		const reason = `${key} drew ${crossed.status} under ${tenant}, neither a refusal nor a success`
		return ctx.findings.unresolved(CHECK, ctx.subject, reason)
	}
	const home = await ctx.client.get(own, { as, operationId, query })
	if (home.status < 300) return ASSERTED
	const reason = `${key} was refused (${home.status}) in its own tenant too, so the refusal proves nothing`
	return ctx.findings.unresolved(CHECK, ctx.subject, reason)
}
