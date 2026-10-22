import { describe, expect, it } from "vitest"
import { inProcess } from "../../src/conformance/harness/launch.ts"
import { judgeDefect } from "../../src/conformance/matrix/cases.ts"

/*
 * The discriminator defect, judged as the conformance matrix judges it, against the reference in process:
 * the search answers a card's fields under the bank tag, which only a union pinned by its tag rules out.
 * It must trip the contract call and nothing the expected table does not accept.
 */

describe("the discriminator defect", () => {
	it("DISCRIMINATOR_BRANCH_WRONG fires its check in process, and nothing else", async () => {
		const judged = await judgeDefect("DISCRIMINATOR_BRANCH_WRONG", {
			backend: "memory",
			dialect: "postgrest",
			via: inProcess,
		})
		expect(judged.error).toBeUndefined()
		expect(judged.expected).toBe("response.contract-call")
		expect(judged.detected).toBe(true)
		expect(judged.spurious).toEqual([])
		/* A coverage gap is no finding: the clean run reports the same ones. */
		const real = judged.findings.filter((finding) => finding.verdict !== "COVERAGE_GAP")
		expect(real.map((finding) => finding.check)).toEqual(["response.contract-call"])
		expect(real[0]?.detail).toMatch(/^search\.query returned 200 with a body that fails the declared schema/)
	}, 240_000)
})
