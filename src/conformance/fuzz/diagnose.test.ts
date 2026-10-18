import { describe, expect, it } from "vitest"
import type { Finding, Verdict } from "../../runtime/finding.ts"
import { ancestorsOf, diagnose, falsePositives, type Reported } from "./diagnose.ts"

function finding(check: string, verdict: Verdict = "BACKEND_BUG"): Finding {
	return { check, detail: `${check} detail`, entity: "widget", evidence: [], summary: `${check} broke`, verdict }
}

function reported(findings: Finding[], inconclusive: Reported["inconclusive"] = []): Reported {
	return { findings, inconclusive }
}

describe("ancestorsOf", () => {
	it("follows dependsOn transitively, each check once", () => {
		const ancestors = ancestorsOf("pagination.cursor-agrees-with-page")
		expect([...ancestors]).toEqual(expect.arrayContaining(["pagination.page-walk-covers-set", "list.read-after-write"]))
		expect(ancestors.has("pagination.cursor-agrees-with-page")).toBe(false)
	})

	it("has none for a check that depends on nothing, or no check at all", () => {
		expect(ancestorsOf("create.keeps-submitted-identity").size).toBe(0)
		expect(ancestorsOf("no.such-check").size).toBe(0)
	})
})

describe("diagnose", () => {
	it("passes a run whose every injected defect fired, ignoring coverage gaps", () => {
		const diagnosis = diagnose(
			["STALE_LIST", "ORDER_IGNORED"],
			reported([finding("list.read-after-write"), finding("sort.order-is-applied"), finding("x.y", "COVERAGE_GAP")]),
		)
		expect(diagnosis).toEqual({ cascaded: [], findings: 2, missed: [], ok: true, spurious: [], unresolved: [] })
	})

	it("excuses a defect whose check a broken dependency suppressed", () => {
		const diagnosis = diagnose(["STALE_LIST", "OFF_BY_ONE_PAGE"], reported([finding("list.read-after-write")]))
		expect(diagnosis.cascaded).toEqual([{ because: "list.read-after-write", defect: "OFF_BY_ONE_PAGE" }])
		expect(diagnosis.ok).toBe(true)
	})

	it("counts a check that said why it could not conclude as unresolved, not missed", () => {
		const inconclusive = [{ check: "sort.order-is-applied", entity: "widget", reason: "one row" }]
		const diagnosis = diagnose(["ORDER_IGNORED"], reported([], inconclusive))
		expect(diagnosis.unresolved).toEqual([{ defect: "ORDER_IGNORED", reason: "one row" }])
		expect(diagnosis.ok).toBe(true)
	})

	it("fails a defect nothing reported, and a finding no defect justifies", () => {
		const diagnosis = diagnose(["ORDER_IGNORED"], reported([finding("search.q-narrows-result")]))
		expect(diagnosis).toEqual({
			cascaded: [],
			findings: 1,
			missed: [{ defect: "ORDER_IGNORED", primary: "sort.order-is-applied" }],
			ok: false,
			spurious: [
				{
					check: "search.q-narrows-result",
					detail: "search.q-narrows-result detail",
					entity: "widget",
					summary: "search.q-narrows-result broke",
				},
			],
			unresolved: [],
		})
	})
})

describe("falsePositives", () => {
	it("lists every real finding, briefly", () => {
		expect(falsePositives(reported([finding("sort.order-is-applied"), finding("x.y", "COVERAGE_GAP")]))).toEqual([
			{ check: "sort.order-is-applied", entity: "widget", summary: "sort.order-is-applied broke" },
		])
	})
})
