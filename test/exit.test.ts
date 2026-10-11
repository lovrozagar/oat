import { describe, expect, it } from "vitest"
import { EXIT, exitCode, runVerdict } from "../src/runtime/exit.ts"

const ops = (...statuses: string[]) => statuses.map((status) => ({ status }))
const full = (findings: string[], ...statuses: string[]) => ({
	findings: findings.map((verdict) => ({ verdict })),
	scope: { mode: "full", operations: ops(...statuses) },
})

describe("exitCode", () => {
	it("is clean when every graded operation passed", () => {
		expect(exitCode(full([], "passed", "passed"))).toBe(EXIT.clean)
	})

	it("ignores gaps and blocked entries, which are not root causes", () => {
		expect(exitCode(full(["COVERAGE_GAP", "BLOCKED"], "passed"))).toBe(EXIT.clean)
	})

	it("reports defects for a root-cause finding", () => {
		expect(exitCode(full(["BACKEND_BUG"], "passed", "failed"))).toBe(EXIT.defects)
	})

	it("fails a run that graded nothing, rather than passing it", () => {
		expect(exitCode(full([], "skipped"))).toBe(EXIT.failed)
		expect(exitCode(full([]))).toBe(EXIT.failed)
	})

	it("fails a run the network cut short, whatever it found", () => {
		expect(exitCode({ ...full(["BACKEND_BUG"], "passed"), network: { incomplete: true } })).toBe(EXIT.failed)
	})

	it("under --ops, fails when a target was never judged", () => {
		const targeted = { findings: [], scope: { mode: "targeted", operations: ops("passed", "skipped") } }
		expect(exitCode(targeted)).toBe(EXIT.failed)
	})

	it("under --ops, reports defects when a target failed", () => {
		const targeted = { findings: [], scope: { mode: "targeted", operations: ops("passed", "failed") } }
		expect(exitCode(targeted)).toBe(EXIT.defects)
	})

	it("is the verdict every report states, with its reason", () => {
		expect(runVerdict(full([], "skipped"))).toEqual({
			outcome: "failed",
			reason: "no operation was graded, so nothing was proved",
		})
		expect(runVerdict(full(["BACKEND_BUG", "SECURITY"], "failed"))).toEqual({
			outcome: "defects",
			reason: "2 root-cause findings",
		})
		expect(runVerdict(full([], "passed")).outcome).toBe("clean")
	})
})
