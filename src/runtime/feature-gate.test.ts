import { describe, expect, it } from "vitest"
import { describeFeatureGate, featureGateVars, isDocumentedFeatureGateDenial } from "./feature-gate.ts"

const gated = { featureGate: "webhooks" }
const denial = (vars: unknown): unknown => ({ message: "upgrade", vars })

describe("isDocumentedFeatureGateDenial", () => {
	it("is a 403 on a gated route whose vars name the gate, or name no feature", () => {
		expect(isDocumentedFeatureGateDenial(gated, 403, denial({ feature: "webhooks", type: "feature_gate" }))).toBe(true)
		expect(isDocumentedFeatureGateDenial(gated, 403, denial({ type: "feature_gate" }))).toBe(true)
	})

	it("is anything else: an ungated route, another status, another body, or another feature", () => {
		const body = denial({ type: "feature_gate" })
		expect(isDocumentedFeatureGateDenial({ featureGate: null }, 403, body)).toBe(false)
		expect(isDocumentedFeatureGateDenial(gated, 401, body)).toBe(false)
		expect(isDocumentedFeatureGateDenial(gated, 403, null)).toBe(false)
		expect(isDocumentedFeatureGateDenial(gated, 403, "denied")).toBe(false)
		expect(isDocumentedFeatureGateDenial(gated, 403, denial(null))).toBe(false)
		expect(isDocumentedFeatureGateDenial(gated, 403, denial("feature_gate"))).toBe(false)
		expect(isDocumentedFeatureGateDenial(gated, 403, denial({ type: "forbidden" }))).toBe(false)
		expect(isDocumentedFeatureGateDenial(gated, 403, denial({ feature: "sso", type: "feature_gate" }))).toBe(false)
	})
})

describe("describeFeatureGate", () => {
	it("names the gate, with the plans and feature the answer gave", () => {
		const vars = { current_plan: "free", feature: "webhooks", required_plan: 2 }
		expect(describeFeatureGate(gated, denial(vars))).toBe(
			"x-feature-gate: webhooks (current_plan: free, feature: webhooks)",
		)
		expect(describeFeatureGate(gated, denial({ type: "feature_gate" }))).toBe("x-feature-gate: webhooks")
		expect(describeFeatureGate({ featureGate: null }, null)).toBe("x-feature-gate: unknown")
	})

	it("reads vars only from an object answer that has an object under vars", () => {
		expect(featureGateVars(null)).toBeNull()
		expect(featureGateVars(7)).toBeNull()
		expect(featureGateVars({ vars: null })).toBeNull()
		expect(featureGateVars({ vars: "x" })).toBeNull()
		expect(featureGateVars({ vars: { a: 1 } })).toEqual({ a: 1 })
	})
})
