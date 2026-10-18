import { describe, expect, it } from "vitest"
import { inProcess, type Via } from "../harness/launch.ts"
import { runTenantScopeSuite } from "./tenant-scope.ts"

/* A transport that cannot reach anything: each case reports why, and the rest still run. */
const nowhere: Via = {
	host: () => Promise.reject(new Error("no host")),
	launch: () => Promise.reject(new Error("no reference")),
}

describe("runTenantScopeSuite", () => {
	it("keeps a public catalogue out of isolation, and splits stated from inferred tenancy", async () => {
		const results = await runTenantScopeSuite(inProcess)
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.map((r) => r.detail)).toEqual([
			"check did not apply; no finding",
			"SECURITY",
			"AMBIGUITY",
			"check did not apply; no finding",
			"SECURITY",
			"AMBIGUITY",
		])
	}, 180_000)

	it("reports every case it could not run", async () => {
		const results = await runTenantScopeSuite(nowhere)
		expect(results.map((r) => [r.ok, r.detail])).toEqual([
			[false, "no host"],
			[false, "no reference"],
			[false, "no reference"],
			[false, "no host"],
			[false, "no reference"],
			[false, "no reference"],
		])
	})

	it("names the verdict a leak got instead of the one it should have", async () => {
		/* The reference launches without the defect it was asked for: no leak to find. */
		const unbroken: Via = {
			...inProcess,
			launch: (backend, options) => inProcess.launch(backend, { ...options, defects: [] }),
		}
		const results = await runTenantScopeSuite(unbroken)
		expect(results.map((r) => r.detail)).toEqual([
			"check did not apply; no finding",
			"expected SECURITY, got no finding",
			"expected AMBIGUITY, got no finding",
			"check did not apply; no finding",
			"expected SECURITY, got no finding",
			"expected AMBIGUITY, got no finding",
		])
	}, 300_000)
})
