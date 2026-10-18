import { describe, expect, it } from "vitest"
import { PRINCIPALS } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * An effect is judged by calling the action that should cause it. When that call itself fails,
 * nothing about the effect was observed: the check must say it could not conclude, and why. It
 * used to finish as asserted, so a backend whose action crashes and whose effect never happens
 * looked, to everything downstream, as though the effect had been seen.
 */

const CHECK = "effects.declared-effect-occurs"

describe(CHECK, () => {
	it("is unresolved, naming the failed action, when the action that causes the effect crashes", async () => {
		const server = await createMemoryServer({ defects: ["ACTION_CRASHES", "EFFECT_NOT_APPLIED"] })
		try {
			const result = await run({
				baseUrl: server.url,
				principals: PRINCIPALS,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const fired = result.findings.some((finding) => finding.check === CHECK && finding.verdict !== "COVERAGE_GAP")
			const unresolved = result.inconclusive.filter((entry) => entry.check === CHECK)
			expect(fired || unresolved.length > 0).toBe(true)
			if (!fired) expect(unresolved.map((entry) => entry.reason).join(" ")).toMatch(/5\d\d/)
		} finally {
			await server.close()
		}
	}, 240_000)
})
