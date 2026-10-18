/**
 * The verdict on one contract call: a server error fails it, a refusal leaves it untested, an
 * undocumented success proves nothing, and a documented success passes when its body holds to
 * the schema.
 */

import type { Exchange } from "../exchange.ts"
import { documentsStatus } from "../../spec/graph/statuses.ts"
import { describeServerError } from "../rate-limit/retry-after.ts"
import { headerValue } from "../headers.ts"
import { CONTRACT_CHECK_ID } from "./check.ts"
import { snippet } from "./params.ts"
import type { ContractCall, ContractInput } from "./types.ts"

export function judge(
	input: Pick<ContractInput, "findings" | "grades" | "validator">,
	{ op, raw }: Pick<ContractCall, "op" | "raw">,
	exchange: Exchange,
): void {
	const { grades } = input
	const blame = input.findings.attributed([op.operationId]).ownedBy(CONTRACT_CHECK_ID)
	const entity = op.entity ?? op.operationId
	if (exchange.status >= 500) {
		grades.graded([op.operationId], CONTRACT_CHECK_ID)
		blame.backend(CONTRACT_CHECK_ID, entity, {
			summary: `a schema-built request ${describeServerError(exchange.status, headerValue(exchange.responseHeaders, "retry-after"))}`,
			detail: `${op.operationId} returned ${exchange.status}: ${snippet(exchange.responseBody)}`,
			evidence: [exchange],
		})
		return
	}
	if (exchange.status >= 400) {
		grades.skipped(
			[op.operationId],
			`contract call returned ${exchange.status} (${snippet(exchange.responseBody)}); a scenario must set the scene`,
		)
		return
	}
	if (!documentsStatus(op.statuses, exchange.status)) {
		/* `response.status-is-documented` owns that defect; an undocumented success proves nothing here. */
		grades.skipped([op.operationId], `contract call returned ${exchange.status}, which the document does not name`)
		return
	}
	grades.graded([op.operationId], CONTRACT_CHECK_ID)
	/* A documented status with no body schema has nothing more to hold the body to. */
	const result = input.validator.documents(raw, exchange.status)
		? input.validator.validate(op.operationId, raw, exchange)
		: { ok: true, errors: [] as string[], unchecked: undefined }
	if (result.unchecked === undefined && !result.ok) {
		blame.spec(CONTRACT_CHECK_ID, entity, {
			summary: "success response does not match its documented schema",
			detail: `${op.operationId} returned ${exchange.status} with a body that fails the declared schema: ${result.errors.join("; ")}`,
			evidence: [exchange],
		})
		return
	}
	grades.prove(op.operationId, { call: exchange.seq })
}
