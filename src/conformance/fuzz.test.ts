import { describe, expect, it } from "vitest"
import { inProcess, type Via } from "./harness/launch.ts"
import { type FuzzCase, runFuzz, runPrecision } from "./fuzz.ts"

/* A reference that starts, but whose transport fails every request: oat's run fails, not the pass. */
const unreachable: Via = {
	...inProcess,
	launch: async (backend, options) => ({
		...(await inProcess.launch(backend, options)),
		fetch: () => Promise.reject(new TypeError("fetch failed")),
	}),
}

/* A reference that will not start at all. */
const refusing: Via = { ...inProcess, launch: () => Promise.reject(new Error("no reference")) }

describe("runFuzz", () => {
	it("injects a distinct random set of defects per case, replayable from its seed", async () => {
		const seen: FuzzCase[] = []
		const options = { cases: 1, maxDefects: 40, onCase: (result: FuzzCase) => seen.push(result), via: inProcess }
		const [result] = await runFuzz(options)
		expect(seen).toEqual([result])
		expect(result?.error).toBeUndefined()
		expect(new Set(result?.injected).size).toBe(result?.injected.length)
		expect(result?.findings).toBeGreaterThan(0)
		const [again] = await runFuzz({ cases: 1, maxDefects: 40, seed: 1, via: inProcess })
		expect(again?.injected).toEqual(result?.injected)
	}, 120_000)

	it("switches on a drawn defect's opt-in, in the reference and in oat", async () => {
		/* Seed 49 draws LOGIN_NOT_THROTTLED alone, which shows only with login throttling on. */
		const [result] = await runFuzz({ cases: 1, maxDefects: 1, seed: 49, via: inProcess })
		expect(result).toMatchObject({ injected: ["LOGIN_NOT_THROTTLED"], missed: [], ok: true })
	}, 120_000)

	it("records a run that failed as the case's error", async () => {
		const results = await runFuzz({ cases: 2, maxDefects: 1, seed: 7, via: unreachable })
		expect(results.map((result) => [result.ok, result.findings, result.injected.length])).toEqual([
			[false, 0, 1],
			[false, 0, 1],
		])
		expect(results[0]?.error).toMatch(/^GET http:\/\/reference\.test\/v1\/openapi\/spec failed/)
	})

	it("fails the pass when the reference will not start", async () => {
		await expect(runFuzz({ cases: 1, via: refusing })).rejects.toThrow("no reference")
	})
})

describe("runPrecision", () => {
	it("finds nothing against a correct backend", async () => {
		const results = await runPrecision({ cases: 1, via: inProcess })
		expect(results).toEqual([{ findings: [], inconclusive: expect.any(Number), seed: expect.any(Number) }])
	}, 120_000)

	it("records a run that failed as the cohort's error", async () => {
		const [result] = await runPrecision({ cases: 1, seed: 3, via: unreachable })
		expect(result).toEqual({
			error: expect.stringMatching(/openapi\/spec failed/),
			findings: [],
			inconclusive: 0,
			seed: 237_230,
		})
	})
})
