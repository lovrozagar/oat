/**
 * When a 403 is the document, not a defect.
 *
 * `x-feature-gate` names a plan key. A free principal hitting that route and receiving
 * `vars.type === "feature_gate"` is the product working as published. Treating that the same as
 * a broken create is the class of mistake that turns a correct backend into `world.seed` BLOCKED.
 */

import type { OperationObject } from "../spec/types.ts"
import type { OperationModel } from "../spec/graph.ts"
import type { Exchange } from "./client.ts"
import type { FindingCollector } from "./finding.ts"
import type { SchemaValidator } from "./validate.ts"

/** Forbidden status unless a later abstraction names another one — the documented default. */
export const FEATURE_GATE_STATUS = 403

export function isDocumentedFeatureGateDenial(
	op: Pick<OperationModel, "featureGate">,
	status: number,
	body: unknown,
): boolean {
	if (op.featureGate === null) return false
	if (status !== FEATURE_GATE_STATUS) return false
	if (body === null || typeof body !== "object") return false
	const vars = (body as Record<string, unknown>).vars
	if (vars === null || typeof vars !== "object") return false
	const rec = vars as Record<string, unknown>
	if (rec.type !== "feature_gate") return false
	/* A string that disagrees with the tag is backend/tag drift — keep today's failure. Absent
	 * `vars.feature` is enough together with `type`; do not invent a mismatch. */
	if (typeof rec.feature === "string" && rec.feature !== op.featureGate) return false
	return true
}

export function describeFeatureGate(op: Pick<OperationModel, "featureGate">, body: unknown): string {
	const key = op.featureGate ?? "unknown"
	const vars = featureGateVars(body)
	if (vars === null) return `x-feature-gate: ${key}`
	const extras = ["current_plan", "required_plan", "feature"]
		.filter((name) => typeof vars[name] === "string")
		.map((name) => `${name}: ${vars[name]}`)
	return extras.length === 0 ? `x-feature-gate: ${key}` : `x-feature-gate: ${key} (${extras.join(", ")})`
}

export function featureGateVars(body: unknown): Record<string, unknown> | null {
	if (body === null || typeof body !== "object") return null
	const vars = (body as Record<string, unknown>).vars
	if (vars === null || typeof vars !== "object") return null
	return vars as Record<string, unknown>
}

/**
 * A gate 403 still has to match the documented error schema. Coverage is "this 403 is
 * expected"; it is not a free pass for an undeclared body.
 */
export function reportFeatureGateSchemaDrift(
	findings: FindingCollector,
	validator: SchemaValidator,
	op: OperationModel,
	raw: OperationObject | undefined,
	exchange: Exchange,
	entity: string,
): void {
	if (raw === undefined) return
	if (!validator.documents(raw, exchange.status)) return
	const result = validator.validate(op.operationId, raw, exchange.status, exchange.responseBody)
	if (result.ok) return
	if (
		findings.findings.some(
			(finding) =>
				finding.check === "schema.error-response-matches-document" &&
				finding.entity === entity &&
				finding.evidence.some((prior) => prior.seq === exchange.seq),
		)
	) {
		return
	}
	findings.spec(
		"schema.error-response-matches-document",
		entity,
		`${exchange.status} error body does not match its documented schema`,
		`${op.operationId} returned ${exchange.status} with a body that fails the schema the ` +
			`document declares for it: ${result.errors.join("; ")}. Clients that parse errors ` +
			"from the spec will not understand this response.",
		[exchange],
	)
}
