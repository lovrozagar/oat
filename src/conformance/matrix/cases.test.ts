import { afterEach, describe, expect, it } from "vitest"
import { inProcess, type Target } from "../harness/launch.ts"
import { judgeDefect, portableResult, runBaselines, runSuite } from "./cases.ts"

const MEMORY: Target = { backend: "memory", dialect: "postgrest", via: inProcess }
/* D1 without credentials: the reference cannot even start, so every case reports why. */
const UNREACHABLE: Target = { backend: "d1", dialect: "postgrest", via: inProcess }
const D1 = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN"] as const
const saved = { ...process.env }

afterEach(() => {
	process.env = { ...saved }
})

describe("runSuite", () => {
	it("runs the baselines, then each defect the filter names", async () => {
		const results = await runSuite(MEMORY, ["STALE_LIST"])
		expect(results.map((result) => [result.label, result.detected, result.spurious.length])).toEqual([
			["baseline (correct backend)", true, 0],
			["baseline (untagged spec)", true, 0],
			["STALE_LIST", true, 0],
		])
		const [tagged, untagged, defect] = results
		expect(tagged).toMatchObject({ bystanders: [], leaked: 0, strayLedger: [], unreported: [] })
		expect(untagged?.leaked).toBeUndefined()
		expect(defect).toMatchObject({
			acceptable: expect.arrayContaining(["list.read-after-write"]),
			expected: "list.read-after-write",
		})
	}, 180_000)
})

describe("judgeDefect", () => {
	it("leaves out the bystanders a defect damages by design", async () => {
		const result = await judgeDefect("PATCH_REPLACES", MEMORY, "patch")
		expect(result).toMatchObject({ bystanders: [], detected: true, label: "patch" })
	}, 120_000)

	it("reports why a case could not run", async () => {
		for (const name of D1) delete process.env[name]
		const result = await judgeDefect("STALE_LIST", UNREACHABLE)
		expect(result).toMatchObject({ checksRun: [], detected: false, error: expect.stringMatching(/D1 backend needs/) })
	})
})

describe("runBaselines", () => {
	it("reports why each baseline could not run", async () => {
		for (const name of D1) delete process.env[name]
		const results = await runBaselines(UNREACHABLE)
		expect(results.map((result) => [result.label, result.detected, result.error !== undefined])).toEqual([
			["baseline (correct backend)", false, true],
			["baseline (untagged spec)", false, true],
		])
	})
})

describe("portableResult", () => {
	it("drops the exchanges findings cite, and keeps the rest", () => {
		const finding = {
			check: "c",
			detail: "d",
			entity: "e",
			evidence: [{ seq: 1 }],
			summary: "s",
			verdict: "BACKEND_BUG",
		}
		const result = {
			checksRun: ["c"],
			defect: null,
			detected: true,
			entitiesTested: ["e"],
			expected: null,
			findings: [finding],
			label: "l",
			spurious: [finding],
		} as never
		const portable = portableResult(result)
		expect(portable.findings[0]?.evidence).toEqual([])
		expect(portable.spurious[0]?.evidence).toEqual([])
		expect(portable.findings[0]?.summary).toBe("s")
	})
})
