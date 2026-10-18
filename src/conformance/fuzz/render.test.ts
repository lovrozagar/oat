import { describe, expect, it } from "vitest"
import type { FuzzCase, PrecisionCase } from "./diagnose.ts"
import { renderFuzz, renderPrecision } from "./render.ts"

const clean: FuzzCase = {
	cascaded: [{ because: "list.read-after-write", defect: "OFF_BY_ONE_PAGE" }],
	findings: 1,
	injected: ["STALE_LIST", "OFF_BY_ONE_PAGE"],
	missed: [],
	ok: true,
	seed: 11,
	spurious: [],
	unresolved: [{ defect: "ORDER_IGNORED", reason: "one row" }],
}

const wrong: FuzzCase = {
	...clean,
	cascaded: [],
	missed: [{ defect: "ORDER_IGNORED", primary: "sort.order-is-applied" }],
	ok: false,
	seed: 22,
	spurious: [
		{ check: "a.b", detail: "line one\n\n  line   two", entity: "widget", summary: "a broke" },
		{ check: "c.d", detail: "x".repeat(250), entity: "", summary: "c broke" },
	],
	unresolved: [],
}

const crashed: FuzzCase = { ...clean, cascaded: [], error: "fetch failed", ok: false, seed: 33, unresolved: [] }

describe("renderFuzz", () => {
	it("lists each failed combination with what it missed and invented, then the totals", () => {
		const { failures, text } = renderFuzz([clean, wrong, crashed])
		expect(failures).toBe(2)
		expect(text.split("\n")).toEqual([
			"",
			"  combination fuzzing — random defect sets, one run each",
			"  ─────────────────────────────────────────────────────────────────────────",
			"  ✗ seed 22  [STALE_LIST + OFF_BY_ONE_PAGE]",
			"      missed   ORDER_IGNORED — expected sort.order-is-applied, nothing fired",
			"      spurious a.b (widget)",
			"               a broke",
			"               line one line two",
			"      spurious c.d",
			"               c broke",
			`               ${"x".repeat(200)}`,
			"  ✗ seed 33  [STALE_LIST + OFF_BY_ONE_PAGE]",
			"      run failed: fetch failed",
			"",
			"  1/3 combinations diagnosed correctly · 1 suppressed as cascades · 1 reported as inconclusive",
			"",
		])
	})
})

describe("renderPrecision", () => {
	it("lists each cohort with a false positive or a failed run, then the totals", () => {
		const cases: PrecisionCase[] = [
			{ findings: [], inconclusive: 2, seed: 1 },
			{ findings: [{ check: "a.b", entity: "widget", summary: "a broke" }], inconclusive: 0, seed: 2 },
			{ error: "fetch failed", findings: [], inconclusive: 0, seed: 3 },
		]
		const { failures, text } = renderPrecision(cases)
		expect(failures).toBe(2)
		expect(text.split("\n")).toEqual([
			"",
			"  precision stress — correct backend, varied cohort data",
			"  ─────────────────────────────────────────────────────────────────────────",
			"  ✗ seed 2",
			"      false positive a.b (widget) — a broke",
			"  ✗ seed 3",
			"      run failed: fetch failed",
			"",
			"  1/3 cohorts produced no false positives · 2 check(s) reported as inconclusive",
			"",
		])
	})
})
