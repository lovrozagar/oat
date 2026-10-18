import { describe, expect, it } from "vitest"
import { exchange, finding, reportOf, scopeOf } from "./__fixtures__/report.ts"
import { renderConsole } from "./summary.ts"

describe("renderConsole's summary", () => {
	it("says a clean run found no defects, in a few lines", () => {
		expect(renderConsole(reportOf()).split("\n")).toEqual([
			"",
			"  1 checks · 1 entities · 0 requests · 1.5s · 0 bytes req · 0 bytes res",
			"  result: clean — no defects found in what was graded",
			"",
			"  no defects found",
			"",
		])
	})

	it("says a run with no findings still failed when it did", () => {
		const text = renderConsole(
			reportOf({ network: { attempts: 3, incomplete: true, kind: "timeout", url: "http://h.test", waitedMs: 0 } }),
		)
		expect(text).toContain("  run failed — the network went away before the run finished")
	})

	it("adds latency, shortfalls, the profile, the scope and the baseline to the summary", () => {
		const text = renderConsole(
			reportOf(
				{
					baseline: { fixed: [{ check: "gone", reason: "r" }] },
					checksSkipped: [
						{ check: "never", entity: "a", needs: "a list" },
						{ check: "never", entity: "b", needs: "a list" },
						{ check: "some", entity: "a", needs: "x" },
					],
					entitiesTested: ["a", "b"],
					profileExclusions: [{ entity: "a", operationId: "a.delete", reason: "x-destructive" }],
					scope: scopeOf(),
				},
				[exchange({ durationMs: 30 })],
			),
		)
		const lines = text.split("\n")
		expect(lines[1]).toBe(
			"  1 checks · 2 entities · 1 requests · 1.5s · p95 30ms · 0 bytes req · 0 bytes res · 1 checks did not apply · 1 only on some entities",
		)
		expect(lines).toContain("  skipped 1 operation(s) under --profile ? (1 destructive)")
		expect(lines).toContain("  scope: full · 1 of 1 operations graded")
		expect(lines).toContain("  baseline: 0 known · 1 fixed")
		expect(lines).toContain("  DID NOT APPLY — no entity had what these need")
		expect(lines).toContain(`    ${"never".padEnd(40)} needs a list`)
		expect(lines).toContain("  APPLIED ONLY ON SOME ENTITIES")
		expect(lines).toContain(`    ${"some".padEnd(40)} ran on 1 · skipped on 1 (a)`)
	})
})

describe("renderConsole's findings and untested checks", () => {
	it("lists findings by severity, known ones included, and counts the known in the baseline line", () => {
		const text = renderConsole(
			reportOf({
				findings: [
					finding({ entity: "row", summary: "list is stale" }),
					finding({ check: "c.k", known: { reason: "t" }, verdict: "SPEC_BUG" }),
					finding({ origin: "b", verdict: "COVERAGE_GAP" }),
				],
			}),
		)
		const lines = text.split("\n")
		expect(lines).toContain("  baseline: 1 known · 0 fixed")
		expect(lines).toContain("  BACKEND DEFECTS (1)")
		expect(lines).toContain(`    ${"row".padEnd(16)} list is stale`)
		expect(lines).toContain(`    ${"".padEnd(16)} sort.order-is-applied`)
		expect(lines).toContain("  SPECIFICATION DRIFT (1)")
		expect(lines).toContain("  COVERAGE GAPS (1)")
		expect(lines).toContain(`    ${"b/row".padEnd(16)} s`)
		expect(text).not.toContain("no defects found")
	})

	it("names what was blocked, everywhere or on some entities, and what could not conclude", () => {
		const text = renderConsole(
			reportOf({
				checksSuppressed: [
					{ because: "create.returns-record", check: "everywhere", entity: "a" },
					{ because: "create.returns-record", check: "everywhere", entity: "b" },
					{ because: "read.matches-list", check: "partly", entity: "a" },
				],
				entitiesTested: ["a", "b"],
				inconclusive: [
					{ check: "z.check", entity: "a", reason: "first" },
					{ check: "z.check", entity: "b", reason: "last wins" },
					{ check: "a.check", entity: "a", reason: "timed out" },
				],
			}),
		)
		const lines = text.split("\n")
		expect(lines).toContain("  BLOCKED BY AN EARLIER FAILURE — re-run once the cause is fixed")
		expect(lines).toContain(`    ${"everywhere".padEnd(40)} waiting on create.returns-record`)
		expect(lines).toContain("  BLOCKED ON SOME ENTITIES")
		expect(lines).toContain(`    ${"partly".padEnd(40)} ran on 1 · blocked on 1 (a) · waiting on read.matches-list`)
		const conclude = lines.indexOf("  COULD NOT CONCLUDE")
		expect(lines.slice(conclude, conclude + 6)).toEqual([
			"  COULD NOT CONCLUDE",
			"    a.check",
			"      timed out",
			"    z.check",
			"      last wins",
			"",
		])
	})
})
