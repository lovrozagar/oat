import { describe, expect, it } from "vitest"
import { exchange, reportOf, scopeOf } from "./__fixtures__/report.ts"
import { coverageByCheck } from "./coverage.ts"
import { headLines } from "./markdown-head.ts"

const clean = { outcome: "clean" as const, reason: "no defects" }

describe("headLines on a plain run", () => {
	it("summarises a plain run: backend, result, timing, entities, checks and requests", () => {
		const input = reportOf()
		expect(headLines(input, clean, coverageByCheck(input))).toEqual([
			"# oat report",
			"",
			"- **Backend**: http://h.test",
			"- **Result**: clean — no defects",
			"- **Generated**: 1970-01-01T00:00:00.000Z (1.5s)",
			"- **Entities tested**: row",
			"- **Checks run**: 1",
			"- **Requests**: 0 (0 bytes req · 0 bytes res)",
			"- **Matrix**: [matrix.html](./matrix.html) · [matrix.json](./matrix.json)",
			"",
		])
	})
})

describe("headLines on a run with everything to say", () => {
	it("adds the build, interruption, scope, coverage shortfalls, profile, journal, network, latency and cost", () => {
		const input = reportOf(
			{
				checkTimings: [{ check: "a", entity: "x", ms: 2500 }],
				checksSkipped: [
					{ check: "never", entity: "x", needs: "n" },
					{ check: "never", entity: "y", needs: "n" },
					{ check: "some", entity: "x", needs: "n" },
				],
				checksSuppressed: [
					{ because: "a", check: "held", entity: "x" },
					{ because: "a", check: "held", entity: "y" },
				],
				entitiesTested: ["x", "y"],
				exchanges: { count: 2 },
				inconclusive: [
					{ check: "q", entity: "x", reason: "r" },
					{ check: "q", entity: "y", reason: "r" },
				],
				interrupted: true,
				network: { attempts: 3, incomplete: true, kind: "timeout", url: "http://h.test", waitedMs: 2600 },
				profile: "cheap",
				profileExclusions: [{ entity: "x", operationId: "x.delete", reason: "x-destructive" }],
				scope: scopeOf(),
				targetVersion: { value: "1.2.3" },
			},
			[exchange({ check: "a", durationMs: 40, requestBytes: 100, responseBytes: 2048 }), exchange({ durationMs: 10 })],
		)
		const lines = headLines(input, clean, coverageByCheck(input))
		expect(lines).toContain("- **Target version**: 1.2.3")
		expect(lines).toContain("- **Interrupted**: stopped by a signal; teardown ran")
		expect(lines).toContain("- **Scope**: full — 1 of 1 operations graded")
		expect(lines).toContain("- **Checks that did not apply anywhere**: 1")
		expect(lines).toContain("- **Checks that applied only on some entities**: 1")
		expect(lines).toContain("- **Checks blocked by an earlier failure**: 1")
		expect(lines).toContain("- **Checks that could not conclude**: 1")
		expect(lines).toContain("- **Profile**: skipped 1 operation(s) under --profile cheap (1 destructive)")
		expect(lines).toContain("- **Requests**: 2 (100 bytes req · 2.0 KB res)")
		expect(lines).toContain("- **Exchanges**: 2 → [exchanges/](./exchanges/)")
		expect(lines).toContain(
			"- **Network**: timeout after 3 attempt(s) · waited 3s — run incomplete, not a backend defect",
		)
		expect(lines).toContain("- **Latency**: p50 40ms · p95 40ms · max 40ms (GET /v1/rows)")
		expect(lines).toContain("- **Costliest checks**: a 1 req · 2.5s")
	})

	it("says why the build is unknown, and a network that recovered without waiting", () => {
		const input = reportOf({
			network: { attempts: 1, incomplete: false, kind: "reset", url: "http://h.test", waitedMs: 0 },
			targetVersion: { error: "no version header" },
		})
		const lines = headLines(input, clean, coverageByCheck(input))
		expect(lines).toContain("- **Target version**: unknown — no version header")
		expect(lines).toContain("- **Network**: reset after 1 attempt(s)")
	})
})

describe("headLines' cost line", () => {
	it("names the costliest five checks only", () => {
		const transcript = ["a", "b", "c", "d", "e", "f"].map((check) => exchange({ check }))
		const input = reportOf({}, transcript)
		const cost = headLines(input, clean, coverageByCheck(input)).find((line) => line.startsWith("- **Costliest"))
		expect(cost).toBe(
			"- **Costliest checks**: a 1 req · 0.0s, b 1 req · 0.0s, c 1 req · 0.0s, d 1 req · 0.0s, e 1 req · 0.0s",
		)
	})
})
