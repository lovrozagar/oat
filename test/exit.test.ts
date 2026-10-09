import { describe, expect, it } from "vitest"
import { EXIT, exitCode } from "../src/runtime/exit.ts"

const ops = (...statuses: string[]) => statuses.map((status) => ({ status }))
const full = (findings: string[], ...statuses: string[]) => ({
	findings: findings.map((verdict) => ({ verdict })),
	scope: { mode: "full", operations: ops(...statuses) },
})

describe("exitCode", () => {
	it("is clean when every graded operation held", () => {
		expect(exitCode(full([], "held", "held"))).toBe(EXIT.clean)
	})

	it("ignores gaps and blocked entries, which are not root causes", () => {
		expect(exitCode(full(["COVERAGE_GAP", "BLOCKED"], "held"))).toBe(EXIT.clean)
	})

	it("reports defects for a root-cause finding", () => {
		expect(exitCode(full(["BACKEND_BUG"], "held", "failed"))).toBe(EXIT.defects)
	})

	it("fails a run that graded nothing, rather than passing it", () => {
		expect(exitCode(full([], "skipped"))).toBe(EXIT.failed)
		expect(exitCode(full([]))).toBe(EXIT.failed)
	})

	it("fails a run the network cut short, whatever it found", () => {
		expect(exitCode({ ...full(["BACKEND_BUG"], "held"), network: { incomplete: true } })).toBe(EXIT.failed)
	})

	it("under --ops, fails when a target was never judged", () => {
		const targeted = { findings: [], scope: { mode: "targeted", operations: ops("held", "skipped") } }
		expect(exitCode(targeted)).toBe(EXIT.failed)
	})

	it("under --ops, reports defects when a target failed", () => {
		const targeted = { findings: [], scope: { mode: "targeted", operations: ops("held", "failed") } }
		expect(exitCode(targeted)).toBe(EXIT.defects)
	})
})
