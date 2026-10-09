/**
 * When a 403 is the document, not a defect.
 *
 * `x-feature-gate` names a plan key. A free principal hitting that route and receiving
 * `vars.type === "feature_gate"` is the product working as published. Treating that the same as
 * a broken create is the class of mistake that turns a correct backend into `world.seed` BLOCKED.
 */

import type { OperationModel } from "../spec/graph.ts"

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
