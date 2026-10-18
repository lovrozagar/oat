import { describe, expect, it } from "vitest"
import { UsageError } from "../errors/usage-error.ts"
import { applyBaseline, baselineFrom, parseBaseline } from "./baseline.ts"
import type { Finding } from "./finding.ts"

function finding(overrides: Partial<Finding>): Finding {
	return { check: "c", detail: "d", entity: "row", evidence: [], summary: "s", verdict: "BACKEND_BUG", ...overrides }
}

describe("parseBaseline", () => {
	it("keeps the keys an entry sets", () => {
		const raw = {
			entries: [
				{ check: "c", reason: "r" },
				{ check: "c", entity: "row", operationId: "op", reason: "r" },
			],
			version: 1,
		}
		expect(parseBaseline(raw, "b.json")).toEqual({
			entries: [
				{ check: "c", reason: "r" },
				{ check: "c", entity: "row", operationId: "op", reason: "r" },
			],
			version: 1,
		})
	})

	it.each([
		[[], 'b.json: a baseline is { "version": 1, "entries": [...] }'],
		[{ version: 2 }, "b.json: version must be 1"],
		[{ entries: {}, version: 1 }, "b.json: entries must be an array"],
		[{ entries: [null], version: 1 }, "b.json: entries[0] must be an object"],
		[
			{ entries: [{ check: "c", extra: 1, reason: "r" }], version: 1 },
			"b.json: entries[0].extra is not a baseline key",
		],
		[{ entries: [{ check: "", reason: "r" }], version: 1 }, "b.json: entries[0].check must name a check"],
		[{ entries: [{ check: 1, reason: "r" }], version: 1 }, "b.json: entries[0].check must name a check"],
		[
			{ entries: [{ check: "c", reason: "" }], version: 1 },
			"b.json: entries[0].reason must say why the finding is known",
		],
		[{ entries: [{ check: "c" }], version: 1 }, "b.json: entries[0].reason must say why the finding is known"],
		[{ entries: [{ check: "c", entity: 1, reason: "r" }], version: 1 }, "b.json: entries[0].entity must be a string"],
		[
			{ entries: [{ check: "c", operationId: 1, reason: "r" }], version: 1 },
			"b.json: entries[0].operationId must be a string",
		],
	])("refuses %j", (raw, message) => {
		expect(() => parseBaseline(raw, "b.json")).toThrow(new UsageError(message))
	})
})

describe("applyBaseline", () => {
	it("marks root causes an entry matches as known and returns the entries that matched nothing", () => {
		const findings = [
			finding({ check: "a" }),
			finding({ check: "b", entity: "job" }),
			finding({ check: "c", operations: ["row.list"] }),
			finding({ check: "d" }),
			finding({ check: "a", verdict: "COVERAGE_GAP" }),
		]
		const entries = [
			{ check: "a", reason: "known a" },
			{ check: "b", entity: "row", reason: "other entity" },
			{ check: "c", operationId: "row.list", reason: "known c" },
			{ check: "d", operationId: "row.get", reason: "other operation" },
		]
		const { fixed } = applyBaseline(findings, { entries, version: 1 })
		expect(findings.map((f) => f.known?.reason)).toEqual(["known a", undefined, "known c", undefined, undefined])
		expect(fixed.map((entry) => entry.reason)).toEqual(["other entity", "other operation"])
	})
})

describe("baselineFrom", () => {
	it("is one sorted entry per root cause, named by its summary", () => {
		const baseline = baselineFrom([
			finding({ check: "b", summary: "b row" }),
			finding({ check: "a", entity: "row", operations: ["row.list", "row.get"], summary: "a list" }),
			finding({ check: "a", entity: "row", summary: "a row" }),
			finding({ check: "a", entity: "job", summary: "a job" }),
			finding({ check: "a", entity: "job", summary: "a job again" }),
			finding({ check: "a", entity: "job", operations: ["job.get"], summary: "a job get" }),
			finding({ check: "z", verdict: "BLOCKED" }),
		])
		expect(baseline).toEqual({
			entries: [
				{ check: "a", entity: "job", reason: "a job again" },
				{ check: "a", entity: "job", operationId: "job.get", reason: "a job get" },
				{ check: "a", entity: "row", reason: "a row" },
				{ check: "a", entity: "row", operationId: "row.list", reason: "a list" },
				{ check: "b", entity: "row", reason: "b row" },
			],
			version: 1,
		})
	})
})
