import type { OperationModel } from "../../../spec/graph/types.ts"
import type { Exchange } from "../../exchange.ts"
import { describeFeatureGate, isDocumentedFeatureGateDenial } from "../../feature-gate.ts"
import type { CheckContext } from "../core/context.ts"
import { cannot, type Plan } from "../core/plan.ts"

/* ------------------------------------------------------------------- helpers */

/** What a check that predicts stored values from the cohort's fields needs, when the records are what oat sent. */
export const STORED_FIELDS_UNKNOWN: string =
	"records read back from the server: the create answered without the record and there was no item read, " +
	"so the cohort holds only the bodies oat sent"

/**
 * The stand-down for a check that works out from a record's fields what the server must answer —
 * which records a filter selects, which hold a null — when the records are the bodies oat sent
 * (`recordsUnverified`): a field the server defaulted or normalized would read as a defect.
 * `undefined` when the records are the server's.
 */
export function storedFieldsUnknown(ctx: Pick<CheckContext, "recordsUnverified">): Plan<never> | undefined {
	return ctx.recordsUnverified === true ? cannot(STORED_FIELDS_UNKNOWN) : undefined
}

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
	ctx.findings.gap(check, ctx.entityName, {
		summary: `${op.operationId} did not apply`,
		detail:
			`${describeFeatureGate(op, exchange.responseBody)}. The check that needed a 2xx stands ` +
			"down rather than treat the documented 403 as a defect.",
	})
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
