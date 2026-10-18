import { describe, expect, it } from "vitest"
import { reportOf } from "./__fixtures__/report.ts"
import { coverageByCheck, profileExclusionSummary } from "./coverage.ts"

describe("coverageByCheck", () => {
	it("sorts the checks that fell short into never, partial and blocked", () => {
		const coverage = coverageByCheck(
			reportOf({
				checksOutOfScope: [
					{ check: "partly", entity: "c" },
					{ check: "out", entity: "a" },
				],
				checksSkipped: [
					{ check: "nowhere", entity: "a", needs: "a list" },
					{ check: "nowhere", entity: "b", needs: "a list" },
					{ check: "nowhere", entity: "c", needs: "a list" },
					{ check: "partly", entity: "a", needs: "an update" },
				],
				checksSuppressed: [
					{ because: "create.returns-record", check: "blocked", entity: "a" },
					{ because: "create.returns-record", check: "partly", entity: "b" },
				],
				entitiesTested: ["a", "b", "c"],
			}),
		)
		expect(coverage.never.map((row) => row.check)).toEqual(["nowhere"])
		expect(coverage.never[0]).toMatchObject({ needs: "a list", ran: 0, skipped: 3, skippedEntities: ["a", "b", "c"] })
		expect(coverage.partialSkip).toEqual([])
		expect(coverage.blocked.map((row) => [row.check, row.ran, row.blocked, row.blockedEntities])).toEqual([
			["blocked", 2, 1, ["a"]],
			["partly", 0, 1, ["b"]],
		])
	})

	it("counts a check that ran on some entities and was skipped on others", () => {
		const coverage = coverageByCheck(
			reportOf({ checksSkipped: [{ check: "some", entity: "a", needs: "x" }], entitiesTested: ["a", "b"] }),
		)
		expect(coverage.partialSkip).toEqual([
			{ blocked: 0, blockedEntities: [], check: "some", needs: "x", ran: 1, skipped: 1, skippedEntities: ["a"] },
		])
	})

	it("is empty for a run where every check ran everywhere", () => {
		expect(coverageByCheck(reportOf())).toEqual({ blocked: [], never: [], partialSkip: [] })
	})
})

describe("profileExclusionSummary", () => {
	it("says nothing when the profile excluded nothing", () => {
		expect(profileExclusionSummary(reportOf())).toBeNull()
		expect(profileExclusionSummary(reportOf({ profileExclusions: [] }))).toBeNull()
	})

	it("counts the exclusions by kind under the profile's name", () => {
		const summary = profileExclusionSummary(
			reportOf({
				profile: "cheap",
				profileExclusions: [
					{ entity: "row", operationId: "row.export", reason: "x-cost: high" },
					{ entity: "row", operationId: "row.delete", reason: "x-destructive" },
					{ entity: "row", operationId: "row.purge", reason: "excluded by name" },
				],
			}),
		)
		expect(summary).toBe(
			"skipped 3 operation(s) under --profile cheap (1 high-cost, 1 destructive, 1 excluded by name)",
		)
	})

	it("marks a profile it was not told the name of", () => {
		const summary = profileExclusionSummary(
			reportOf({ profileExclusions: [{ entity: "row", operationId: "row.delete", reason: "x-destructive" }] }),
		)
		expect(summary).toBe("skipped 1 operation(s) under --profile ? (1 destructive)")
	})

	it("names only the kinds there were", () => {
		const summary = profileExclusionSummary(
			reportOf({
				profile: "cheap",
				profileExclusions: [{ entity: "row", operationId: "row.export", reason: "x-cost: high" }],
			}),
		)
		expect(summary).toBe("skipped 1 operation(s) under --profile cheap (1 high-cost)")
	})
})
