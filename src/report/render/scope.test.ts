import { describe, expect, it } from "vitest"
import { operation, scopeOf } from "./__fixtures__/report.ts"
import { scopeConsole, scopeLine, scopeSections } from "./scope.ts"

const checks = (over: Partial<ReturnType<typeof operation>["checks"]> = {}) => ({
	failed: [],
	gaps: [],
	inconclusive: [],
	passed: [],
	suppressed: [],
	...over,
})

describe("scopeLine", () => {
	it("counts what a full run graded", () => {
		const scope = scopeOf({ operations: [operation(), operation({ status: "untested" })] })
		expect(scopeLine(scope, " — ")).toBe("full — 1 of 2 operations graded")
	})

	it("names what a targeted run was asked for", () => {
		const requested = { only: ["row"], ops: ["row.list"] }
		expect(scopeLine(scopeOf({ mode: "targeted", requested }), " · ")).toBe(
			"targeted · 1 operation (--ops row.list --only row)",
		)
		const two = scopeOf({ mode: "targeted", operations: [operation(), operation()], requested })
		expect(scopeLine(two, " · ")).toContain("2 operations")
	})
})

describe("scopeSections on a full run", () => {
	it("tables every operation of a full run, escaping pipes in the reason", () => {
		const lines = scopeSections(
			scopeOf({
				operations: [
					operation({
						checks: checks({ failed: ["a.b", "c.d"], inconclusive: ["e"], passed: ["f"], suppressed: ["g"] }),
						origin: "billing",
						status: "failed",
						sufficiency: "verified",
						why: "x | y",
					}),
					operation({ entity: null, reason: "no check applies", status: "untested" }),
					operation({ operationId: "row.get" }),
				],
			}),
		)
		expect(lines).toContain("## Operations")
		expect(lines).toContain(
			"> Every operation in the document and whether any check graded it. `untested` names why not.",
		)
		expect(lines).toContain("| billing:row.list | row | failed | verified | 1 | 2 (a.b, c.d) | 1 | 1 | x \\| y |")
		expect(lines).toContain("| row.list | — | untested |  | 0 | 0 | 0 | 0 | no check applies |")
		expect(lines).toContain("| row.get | row | passed |  | 0 | 0 | 0 | 0 |  |")
		expect(lines.join("\n")).not.toContain("## Support operations")
	})

	it("names skipped origins and profile exclusions", () => {
		const lines = scopeSections(
			scopeOf({
				excluded: [
					{ operationId: "row.delete", reason: "x-destructive" },
					{ operationId: "row.export", reason: "x-cost: high" },
				],
				originsSkipped: ["billing", "search"],
			}),
		)
		expect(lines).toContain("Origins not run — no target named them: billing, search.")
		expect(lines).toContain("Excluded by the profile: row.delete (x-destructive), row.export (x-cost: high).")
	})
})

describe("scopeSections on a targeted run", () => {
	it("lists a targeted run's support operations, or says there were none", () => {
		const none = scopeSections(scopeOf({ mode: "targeted" }))
		expect(none).toContain(
			"> The targets of this run. Everything else oat called is listed under support: called, never graded.",
		)
		expect(none.slice(-6)).toEqual([
			"## Support operations",
			"",
			"> Called to reach or observe a target. Not graded: a defect here is out of this run's scope.",
			"",
			"None.",
			"",
		])
		const some = scopeSections(
			scopeOf({
				mode: "targeted",
				support: [
					{ calls: 3, non2xx: 0, operationId: "auth.token" },
					{ calls: 2, firstFailure: { requestId: "", status: 500 }, non2xx: 1, operationId: "row.create", origin: "b" },
					{ calls: 1, firstFailure: { requestId: "req-9", status: 404 }, non2xx: 1, operationId: "row.get" },
				],
			}),
		)
		expect(some).toContain("| auth.token | 3 | 0 |  |")
		expect(some).toContain("| b:row.create | 2 | 1 | 500 |")
		expect(some).toContain("| row.get | 1 | 1 | 404 (req-9) |")
	})
})

describe("scopeConsole", () => {
	it("is one line for a full run", () => {
		expect(scopeConsole(scopeOf())).toEqual(["  scope: full · 1 of 1 operations graded"])
	})

	it("marks each target of a targeted run with its status and detail", () => {
		const lines = scopeConsole(
			scopeOf({
				mode: "targeted",
				operations: [
					operation({ checks: checks({ failed: ["a"], passed: ["b"] }), findings: 2, status: "failed" }),
					operation({ checks: checks({ inconclusive: ["c"] }), status: "inconclusive" }),
					operation({ checks: checks({ passed: ["d"] }), operationId: "a-very-long-operation.identifier" }),
					operation({ reason: "waiting on create", status: "blocked" }),
					operation({ origin: "o", status: "untested" }),
				],
				requested: { only: [], ops: ["row.list"] },
				support: [{ calls: 1, non2xx: 0, operationId: "auth.token" }],
			}),
		)
		const width = "a-very-long-operation.identifier".length + 2
		expect(lines).toEqual([
			"  scope: targeted · 5 operations (--ops row.list) · 1 support op(s)",
			`    ✗ ${"row.list".padEnd(width)}${"failed".padEnd(14)}2 checks · 2 finding(s) (a)`,
			`    ? ${"row.list".padEnd(width)}${"inconclusive".padEnd(14)}1 checks`,
			`    ✓ ${"a-very-long-operation.identifier".padEnd(width)}${"passed".padEnd(14)}1 checks`,
			`    ○ ${"row.list".padEnd(width)}${"blocked".padEnd(14)}waiting on create`,
			`    ○ ${"o:row.list".padEnd(width)}untested      `,
		])
	})
})
