import { describe, expect, it } from "vitest"
import { Redactor } from "../../security/redact.ts"
import { BASE, finding, reportOf } from "./__fixtures__/report.ts"
import { coverageByCheck } from "./coverage.ts"
import {
	coverageSections,
	fencedSection,
	fixedSection,
	isKnown,
	knownSection,
	leftoverSections,
	observedSection,
	outcomeSection,
} from "./markdown-sections.ts"

const teardown = { failed: [], records: [], removed: 0, unidentified: [], unsupported: [] }
const create = {
	entity: "row",
	method: "POST",
	operationId: "row.create",
	seq: 7,
	status: 201,
	url: `${BASE}/v1/rows?token=abc`,
}
const record = { entity: "row", id: "r1", principal: "alpha", reason: "still listed" }

describe("leftoverSections", () => {
	it("says nothing when teardown removed everything, or did not run", () => {
		expect(leftoverSections(reportOf({ teardown }), new Redactor())).toEqual([])
		expect(leftoverSections(reportOf({ teardown: null }), new Redactor())).toEqual([])
		expect(leftoverSections(reportOf(), new Redactor())).toEqual([])
	})

	it("lists creates with no readable id and records teardown could not show gone", () => {
		const lines = leftoverSections(
			reportOf({ teardown: { ...teardown, failed: [record], unidentified: [create] } }),
			new Redactor(),
		)
		expect(lines.slice(0, 2)).toEqual(["## Leftovers", ""])
		expect(lines).toContain("- `POST http://h.test/v1/rows?token=%3Credacted%3E` · row.create · 201 · exchange #7")
		expect(lines).toContain("- row `r1` · as alpha · still listed")
	})

	it("titles either kind of leftover on its own", () => {
		const unremoved = leftoverSections(reportOf({ teardown: { ...teardown, failed: [record] } }), new Redactor())
		expect(unremoved[0]).toBe("## Leftovers")
		expect(unremoved.join("\n")).not.toContain("Each create answered 2xx")
		const unidentified = leftoverSections(
			reportOf({ teardown: { ...teardown, unidentified: [create] } }),
			new Redactor(),
		)
		expect(unidentified.join("\n")).not.toContain("Records teardown could not show gone")
	})
})

describe("fencedSection", () => {
	it("lists the refused requests, and says nothing when none were", () => {
		expect(fencedSection(reportOf(), new Redactor())).toEqual([])
		expect(fencedSection(reportOf({ fenced: { failRun: true, requests: [] } }), new Redactor())).toEqual([])
		const lines = fencedSection(
			reportOf({
				fenced: {
					failRun: false,
					requests: [
						{
							method: "DELETE",
							operationId: "row.delete",
							phase: "teardown",
							reason: "no deletes",
							url: `${BASE}/v1/rows/1`,
						},
						{ method: "GET", phase: "load", reason: "offline", url: `${BASE}/spec` },
					],
				},
			}),
			new Redactor(),
		)
		expect(lines).toEqual([
			"## Fenced requests",
			"",
			"- `DELETE http://h.test/v1/rows/1` · row.delete · teardown · no deletes",
			"- `GET http://h.test/spec` · — · load · offline",
			"",
		])
	})
})

describe("observedSection", () => {
	it("says each observation once, with the entities it held on", () => {
		expect(observedSection(reportOf())).toEqual([])
		const lines = observedSection(
			reportOf({
				checkNotes: [
					{ check: "a", entity: "row", note: "PATCH merges" },
					{ check: "a", entity: "table", note: "PATCH merges" },
					{ check: "b", entity: "row", note: "ids are opaque" },
				],
			}),
		)
		expect(lines).toEqual(["## Observed behaviour", "", "- PATCH merges (row, table)", "- ids are opaque (row)", ""])
	})
})

describe("outcomeSection", () => {
	it("says there were no defects, or that the run failed without any", () => {
		const input = reportOf({ checksRun: ["a", "b"] })
		expect(outcomeSection(input, [], { outcome: "clean", reason: "ok" }, 0)).toEqual([
			"No defects found across 2 checks.",
			"",
		])
		expect(outcomeSection(input, [], { outcome: "failed", reason: "the network went away" }, 0)).toEqual([
			"No defects found, but the run failed: the network went away.",
			"",
		])
	})

	it("counts findings per severity", () => {
		const findings = [finding(), finding(), finding({ verdict: "SECURITY" })]
		expect(outcomeSection(reportOf(), findings, { outcome: "defects", reason: "" }, 3)).toEqual([
			"## Summary",
			"",
			"| severity | count |",
			"| --- | --- |",
			"| Security | 1 |",
			"| Backend defects | 2 |",
			"",
		])
	})
})

describe("knownSection", () => {
	it("lists the findings the baseline named", () => {
		const known = [finding({ known: { reason: "TICKET-1" } }), finding()].filter(isKnown)
		expect(knownSection([])).toEqual([])
		expect(knownSection(known)).toEqual([
			"## Known",
			"",
			"Named by the baseline: reported, and not counted against the run.",
			"",
			"- **sort.order-is-applied** on row — s _(known: TICKET-1)_",
			"",
		])
	})
})

describe("fixedSection", () => {
	it("lists baseline entries nothing matched, with where they applied", () => {
		expect(fixedSection(reportOf())).toEqual([])
		expect(fixedSection(reportOf({ baseline: { fixed: [] } }))).toEqual([])
		const lines = fixedSection(
			reportOf({
				baseline: {
					fixed: [
						{ check: "a", reason: "r1" },
						{ check: "b", entity: "row", reason: "r2" },
						{ check: "c", entity: "row", operationId: "row.get", reason: "r3" },
						{ check: "d", operationId: "row.get", reason: "r4" },
					],
				},
			}),
		)
		expect(lines.slice(4)).toEqual([
			"- **a** — r1",
			"- **b** (row) — r2",
			"- **c** (row · row.get) — r3",
			"- **d** (row.get) — r4",
			"",
		])
	})
})

describe("coverageSections", () => {
	it("lists checks that applied nowhere and those that applied only on some entities", () => {
		expect(coverageSections(coverageByCheck(reportOf()))).toEqual([])
		const coverage = coverageByCheck(
			reportOf({
				checksSkipped: [
					{ check: "never", entity: "a", needs: "a list" },
					{ check: "never", entity: "b", needs: "a list" },
					{ check: "some", entity: "a", needs: "x" },
				],
				entitiesTested: ["a", "b"],
			}),
		)
		expect(coverageSections(coverage)).toEqual([
			"## Did not apply anywhere",
			"",
			"- `never` — a list (all 2 entities)",
			"",
			"## Applied only on some entities",
			"",
			"- `some` — ran on 1, skipped on 1 (a)",
			"",
		])
		expect(coverageSections({ ...coverage, never: [] })[0]).toBe("## Applied only on some entities")
	})
})
