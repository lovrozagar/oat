import type { OperationModel } from "../../../spec/graph/types.ts"
import type { Exchange } from "../../exchange.ts"
import { describeFeatureGate, isDocumentedFeatureGateDenial } from "../../feature-gate.ts"
import type { CheckContext } from "../core/context.ts"

/* ------------------------------------------------------------------- helpers */

/**
 * A documented feature-gate 403 is not a 2xx-check failure and not SECURITY.
 *
 * The check that needed a success stands down with a named gap. The 403 body is still judged
 * against the documented error schema, by schema.error-response-matches-document.
 */
export function standDownForFeatureGate(
	ctx: CheckContext,
	op: OperationModel | undefined,
	exchange: Exchange,
	check: string,
): boolean {
	if (op === undefined) return false
	if (!isDocumentedFeatureGateDenial(op, exchange.status, exchange.responseBody)) return false
	/* The 403 body is judged against its schema by schema.error-response-matches-document. */
	ctx.findings.gap(
		check,
		ctx.entityName,
		`${op.operationId} did not apply`,
		`${describeFeatureGate(op, exchange.responseBody)}. The check that needed a 2xx stands ` +
			"down rather than treat the documented 403 as a defect.",
	)
	return true
}

/**
 * A 429 that survived Client retries is the bucket, not the backend. The check that needed a
 * 2xx stands down; it is not a defect and it is not a concurrency conclusion.
 */
export function standDownForRateLimit(ctx: CheckContext, exchange: Exchange, check: string): boolean {
	if (exchange.status !== 429) return false
	ctx.findings.unresolved(
		check,
		ctx.entityName,
		"the request was rate-limited (429) after retries, so this check could not complete",
	)
	return true
}
