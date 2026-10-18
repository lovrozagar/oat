import { describe, expect, it } from "vitest"
import { EXIT, exitCode, runVerdict } from "./exit.ts"

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
})

describe("exitCode on what a run left or could not do", () => {
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

const fenced = (count: number, failRun: boolean) => ({
	...full([], "passed"),
	fenced: { failRun, requests: Array.from({ length: count }, () => ({})) },
})

describe("runVerdict on fences and targets", () => {
	it("fails a run whose fence refused requests, when the fence fails runs", () => {
		expect(runVerdict(fenced(1, true))).toEqual({ outcome: "failed", reason: "1 request was fenced" })
		expect(runVerdict(fenced(2, true))).toEqual({ outcome: "failed", reason: "2 requests were fenced" })
		expect(runVerdict(fenced(2, false)).outcome).toBe("clean")
		expect(runVerdict(fenced(0, true)).outcome).toBe("clean")
	})

	it("names unidentified creates in number", () => {
		const one = runVerdict({ ...full([], "passed"), teardown: { unidentified: [{}] } })
		expect(one.reason).toBe("records may remain: 1 create answered 2xx with no readable id")
		const two = runVerdict({ ...full([], "passed"), teardown: { unidentified: [{}, {}] } })
		expect(two.reason).toBe("records may remain: 2 creates answered 2xx with no readable id")
	})

	it("is clean with no scope to grade, and under --ops when every target passed", () => {
		expect(runVerdict({ findings: [] }).outcome).toBe("clean")
		expect(runVerdict({ findings: [], scope: { mode: "targeted", operations: ops("passed") } }).outcome).toBe("clean")
	})

	it("under --ops, excuses a target that failed only on findings a baseline names", () => {
		const scope = {
			mode: "targeted",
			operations: [
				{ operationId: "row.get", status: "failed" },
				{ operationId: "row.list", status: "passed" },
			],
		}
		const known = { known: { reason: "r" }, operations: ["row.get"], verdict: "BACKEND_BUG" }
		expect(runVerdict({ findings: [known, { verdict: "COVERAGE_GAP" }], scope }).outcome).toBe("failed")
		expect(runVerdict({ findings: [known], scope: { ...scope, operations: [scope.operations[0]!] } })).toEqual({
			outcome: "failed",
			reason: "1 targeted operation(s) were never judged",
		})
		expect(runVerdict({ findings: [], scope }).reason).toBe("1 targeted operation(s) failed")
		const anonymous = { mode: "targeted", operations: [{ status: "failed" }] }
		expect(runVerdict({ findings: [known], scope: anonymous }).outcome).toBe("defects")
	})
})
