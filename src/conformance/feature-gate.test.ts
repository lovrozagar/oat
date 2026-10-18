import { describe, expect, it } from "vitest"
import { buildModel } from "../spec/graph/build.ts"
import { runFeatureGateSuite, shownCases } from "./feature-gate.ts"
import { featureGateHarness } from "./feature-gate/harness.ts"
import { webhookSpec } from "./feature-gate/spec.ts"
import { inProcess, type Via } from "./harness/launch.ts"

const NAMES = [
	"non-string x-feature-gate is null",
	"plan lists x-feature-gate",
	"doctor lists x-feature-gate",
	"matching gate 403 is a coverage gap",
	"untagged invite still seeds",
	"mismatched vars.feature stays a seed error",
	"untagged 403 stays a seed error",
	"gated update after a 201 create is a coverage gap",
	"gated create with existing rows is not a defect",
]

describe("runFeatureGateSuite", () => {
	it("passes every case against its own harness, in process", async () => {
		const results = await runFeatureGateSuite(inProcess)
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.map((r) => r.name)).toEqual(NAMES)
		expect(results[0]?.detail).toBe("featureGate=null")
		expect(results[6]?.detail).toMatch(/^seed=BLOCKED /)
		expect(results[7]?.detail).toMatch(/^seed=none writeGaps=[^n].* defects=none$/)
	}, 120_000)

	it("fails every run it cannot host: the first result of a case with the reason, the rest as thrown", async () => {
		const nowhere: Via = {
			host: () => Promise.reject(new Error("no host")),
			launch: () => Promise.reject(new Error("unused")),
		}
		const results = await runFeatureGateSuite(nowhere)
		expect(results.slice(3).map((r) => [r.ok, r.detail])).toEqual([
			[false, "no host"],
			[false, "harness threw"],
			[false, "no host"],
			[false, "no host"],
			[false, "no host"],
			[false, "no host"],
		])
	})
})

describe("runFeatureGateSuite against a backend that misbehaves", () => {
	it("fails each case when the backend refuses every request", async () => {
		/* Every route but the document answers 401: nothing seeds, and the seed finding says why. */
		const refusing: Via = {
			...inProcess,
			host: (handle) =>
				inProcess.host(async (request) =>
					request.url.pathname === "/v1/openapi/spec"
						? handle(request)
						: { body: '{"error_key":"unauthorized"}', headers: { "content-type": "application/json" }, status: 401 },
				),
		}
		const results = await runFeatureGateSuite(refusing)
		const byName = Object.fromEntries(results.map((r) => [r.name, r]))
		expect(byName["matching gate 403 is a coverage gap"]?.ok).toBe(false)
		expect(byName["untagged invite still seeds"]?.detail).not.toBe("invite has no world.seed finding")
		expect(byName["gated update after a 201 create is a coverage gap"]?.ok).toBe(false)
		expect(byName["gated create with existing rows is not a defect"]?.ok).toBe(false)
	}, 120_000)

	it("names the defects of a backend that creates instead of gating, and breaks its item read", async () => {
		/* Whatever harness a case asks for, this one creates every webhook and answers its read with a 500. */
		const creating = featureGateHarness({ create: "created", specTag: "webhooks" })
		const broken: Via = {
			...inProcess,
			host: () =>
				inProcess.host(async (request) =>
					request.method === "GET" && /\/webhooks\/[^/]+$/.test(request.url.pathname)
						? { body: "{}", headers: { "content-type": "application/json" }, status: 500 }
						: creating(request),
				),
		}
		const results = await runFeatureGateSuite(broken)
		const byName = Object.fromEntries(results.map((r) => [r.name, r]))
		expect(byName["matching gate 403 is a coverage gap"]?.detail).toMatch(/^seed=none detail=— defects=[^n]/)
		expect(byName["untagged 403 stays a seed error"]).toMatchObject({ detail: "seed=none ", ok: false })
		expect(byName["gated create with existing rows is not a defect"]?.detail).toMatch(/^seed=none defects=[A-Z_]+:/)
	}, 120_000)
})

describe("shownCases", () => {
	it("says the tag is missing from plan and doctor when the document has none", () => {
		expect(shownCases(buildModel(webhookSpec(null))).map((r) => [r.ok, r.detail])).toEqual([
			[false, "missing from plan"],
			[false, "missing from doctor"],
		])
	})
})
