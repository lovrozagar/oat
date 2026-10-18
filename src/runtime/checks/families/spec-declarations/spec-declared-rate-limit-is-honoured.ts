import { defineCheck } from "../../core/define.ts"
import type { Exchange } from "../../../exchange.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import type { CheckContext } from "../../core/context.ts"
import { when } from "../../core/plan.ts"
import { ownOps } from "../../planning/subjects.ts"

/**
 * A 429 is a finding only when the request that drew it was demonstrably under a rate the
 * *document* declared — the rate came from `x-rate-limit` and the bucket had a free token, so oat
 * did not have to wait for one. A 429 against a config-supplied rate is the operator's own guess
 * about the environment, not a claim the API made, so it is paced around and never reported; a
 * 429 that only arrived after oat's own bucket made the request wait means oat's rate model was
 * too generous, which is oat's fault, not the backend's.
 *
 * Grouped by category rather than reported per request: the point is "the declared rate for X is
 * wrong", once, not one finding for every request that category serves.
 */
export const declaredRateLimitHonoured = defineCheck({
	plan: (ctx) =>
		when(
			ctx.model.operations.some(
				(op) => op.entity === ctx.entityName && op.rateLimit !== null && op.rateLimit.rps !== null,
			),
		),
	id: "spec.declared-rate-limit-is-honoured",
	judgesTranscript: true,
	needs: "an operation on this entity with a rate declared by x-rate-limit",
	subjects: (entity, model) => ownOps(entity, model, (op) => op.rateLimit !== null && op.rateLimit.rps !== null),
	async run(ctx): Promise<Outcome> {
		const byCategory = new Map<string, Exchange[]>()
		/* Only a route something actually sent was paced and judged. Claiming the rest would mark
		 * them graded with no request behind them, and the contract tier never calls a graded one. */
		const observed = new Set<string>()
		for (const exchange of ctx.client.exchangesForEntity(ctx.entityName)) {
			const paced = declaredRateOp(ctx, exchange)
			if (paced !== undefined) observed.add(paced)
			if (!refusedUnderDeclaredRate(exchange)) continue
			const category = exchange.rateLimitCategory ?? "unknown"
			byCategory.set(category, [...(byCategory.get(category) ?? []), exchange])
		}
		for (const [category, exchanges] of byCategory) {
			ctx.findings.spec(this.id, ctx.entityName, {
				summary: `the declared "${category}" rate limit is not honoured`,
				detail:
					`${exchanges.length} request(s) to the "${category}" category returned 429 despite oat ` +
					"pacing them within the rate x-rate-limit declares — each had a free token in its own " +
					"bucket at the moment it was sent, so this is not oat outrunning its own model. Either " +
					`the declared rate is wrong, or the backend enforces a stricter one than "${category}" ` +
					"documents.",
				evidence: exchanges.slice(0, 3),
			})
		}
		ctx.judged?.([...observed])
		return ASSERTED
	},
})

/** The operation `exchange` was sent to, when the document declares a rate for it. */
function declaredRateOp(ctx: CheckContext, exchange: Exchange): string | undefined {
	const op = exchange.operationId === undefined ? undefined : ctx.model.byOperationId.get(exchange.operationId)
	if (op?.rateLimit?.rps !== null && op?.rateLimit?.rps !== undefined) return op.operationId
	return undefined
}

/** A 429 to a request paced under a document-declared rate while its bucket still had a token. */
function refusedUnderDeclaredRate(exchange: Exchange): boolean {
	return exchange.status === 429 && exchange.rateLimitSource === "tag" && exchange.rateLimitHadRoom === true
}
