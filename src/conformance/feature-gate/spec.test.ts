import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { bearerSecurity } from "../harness/security.ts"
import { webhookSpec } from "./spec.ts"

describe("webhookSpec", () => {
	it("tags webhook create and update, and never an invite", () => {
		const model = buildModel(webhookSpec("webhooks"))
		const gates = Object.fromEntries([...model.byOperationId].map(([id, op]) => [id, op.featureGate]))
		expect(gates).toEqual({
			"invite.create": null,
			"invite.list": null,
			"webhook.create": "webhooks",
			"webhook.list": null,
			"webhook.read": null,
			"webhook.update": "webhooks",
		})
	})

	it("leaves the tag out when there is none", () => {
		const model = buildModel(webhookSpec(null))
		expect([...model.byOperationId.values()].map((op) => op.featureGate)).toEqual(Array(6).fill(null))
		expect(JSON.stringify(webhookSpec(null))).not.toContain("x-feature-gate")
	})
})

describe("webhookSpec security", () => {
	it("requires the bearer on every operation, from the root", () => {
		const doc = webhookSpec("webhooks")
		expect(doc).toMatchObject(bearerSecurity())
		const sources = buildModel(dereference(doc).doc).operations.map((op) => op.security.source)
		expect(new Set(sources)).toEqual(new Set(["root"]))
	})
})
