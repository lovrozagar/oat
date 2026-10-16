import { describe, expect, it } from "vitest"
import { EXIT, exitCode, runVerdict } from "../src/runtime/exit.ts"

const ops = (...statuses: string[]) => statuses.map((status) => ({ status }))
const full = (findings: string[], ...statuses: string[]) => ({
	findings: findings.map((verdict) => ({ verdict })),
	scope: { mode: "full", operations: ops(...statuses) },
})

const listed = (id: string) => ({ entity: "row", id, principal: "alpha", reason: "still listed" })

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

	it("reports leftovers when teardown could not show a record gone, as for an unidentified create", () => {
		const failed = { entity: "row", id: "r1", principal: "beta", reason: "DELETE /rows/r1 returned beta: 403" }
		const teardown = { failed: [failed], unidentified: [], unsupported: [] }
		expect(exitCode({ ...full([], "passed"), teardown })).toBe(EXIT.leftovers)
		expect(exitCode({ ...full(["BACKEND_BUG"], "failed"), teardown })).toBe(EXIT.leftovers)
	})

	it("does not count an entity with no delete operation as a leftover on its own", () => {
		const teardown = { failed: [], unidentified: [], unsupported: ["note"] }
		expect(exitCode({ ...full([], "passed"), teardown })).toBe(EXIT.clean)
	})

	it("counts both kinds of leftover in its reason", () => {
		const unidentified = [{ entity: "row", method: "POST", operationId: "row.create", seq: 4, status: 201, url: "x" }]
		const verdict = runVerdict({
			...full([], "passed"),
			teardown: { failed: [listed("r1"), listed("r2")], unidentified, unsupported: [] },
		})
		expect(verdict).toEqual({
			outcome: "leftovers",
			reason: "records may remain: 2 teardown could not show gone, 1 create answered 2xx with no readable id",
		})
	})
})
