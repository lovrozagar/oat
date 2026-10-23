import type { ReadClient } from "../../../client/client.ts"
import type { Exchange } from "../../exchange.ts"
import { ASSERTED, type Outcome } from "../../finding.ts"
import type { CheckContext } from "../core/context.ts"

/** What a negative probe gets wrong, and so the reason it should be refused for. */
type RefusalReason = "conflict" | "content-type" | "validation"

/** The statuses that mean "refused for this reason", by what a negative probe gets wrong. */
const REFUSED_FOR: Readonly<Record<RefusalReason, readonly number[]>> = {
	conflict: [409],
	"content-type": [415],
	validation: [400, 422],
}

/**
 * Judges the answer to a request sent to be refused. `null` when it was accepted, which the
 * caller judges. Only the statuses that mean "refused for this reason" assert the property; a 5xx
 * is a finding; any other refusal — unauthorized, forbidden, not found, rate limited — turned the
 * request away before the property was ever consulted, so nothing was learned.
 */
export function judgeRefusal(
	ctx: CheckContext,
	check: string,
	reasons: readonly RefusalReason[],
	exchange: Exchange,
): Outcome | null {
	const status = exchange.status
	if (status > 0 && status < 400) return null
	if (reasons.some((reason) => REFUSED_FOR[reason].includes(status))) return ASSERTED
	if (status >= 500) {
		return ctx.findings.backend(check, ctx.entityName, {
			summary: "a request that should be refused drew a server error",
			detail:
				`${exchange.method} ${exchange.url} returned ${status}; invalid input should be refused with ` +
				`${reasons.flatMap((reason) => REFUSED_FOR[reason]).join(" or ")}, not crash the handler.`,
			evidence: [exchange],
		})
	}
	return ctx.findings.unresolved(
		check,
		ctx.entityName,
		`the probe was turned away with ${status}, which does not say the input itself was refused`,
	)
}

/**
 * The context for a request oat sends expecting it to be refused. Its exchanges are marked as
 * probes, so a status the document leaves out for deliberately invalid input is reported apart
 * from what ordinary traffic got.
 */
export function asProbe<C extends ReadClient>(ctx: CheckContext<C>): CheckContext<C> {
	/* What a probe the server accepts anyway creates is ledgered like any other create. */
	return { ...ctx, client: ctx.client.view({ purpose: "probe" }) as C }
}
