import { describe, expect, it } from "vitest"
import type { Finding } from "../../runtime/finding.ts"
import { CHECKS } from "../../runtime/checks/registry.ts"
import type { CaseResult } from "./cases.ts"
import { COVERAGE_FLOOR, passAnswer, renderSuite, renderUnproven } from "./render.ts"

const IDS = CHECKS.map((check) => check.id)

const finding = (check: string, extra: Partial<Finding> = {}): Finding => ({
	check,
	detail: "d",
	entity: "note",
	evidence: [],
	summary: `${check} fired`,
	verdict: "BACKEND_BUG",
	...extra,
})

const tagged = (extra: Partial<CaseResult> = {}): CaseResult => ({
	checksRun: IDS,
	defect: null,
	detected: false,
	entitiesTested: ["note"],
	expected: null,
	findings: [],
	label: "baseline (correct backend)",
	spurious: [],
	...extra,
})

const untagged = (extra: Partial<CaseResult> = {}): CaseResult =>
	tagged({ checksRun: IDS.slice(0, 10), label: "baseline (untagged spec)", ...extra })

const caught = (extra: Partial<CaseResult> = {}): CaseResult => {
	const fired = finding("list.read-after-write", { operations: ["note.list", "note.list", "note.read"] })
	return tagged({
		defect: "STALE_LIST",
		detected: true,
		expected: "list.read-after-write",
		findings: [fired, finding("pagination.page-walk-covers-set", { verdict: "COVERAGE_GAP" })],
		label: "STALE_LIST",
		...extra,
	})
}

describe("renderSuite on a baseline", () => {
	it("passes clean baselines and a caught defect, proving what fired", () => {
		const { failures, proven, text } = renderSuite([tagged(), untagged(), caught()])
		expect(failures).toBe(0)
		expect([...proven]).toEqual(["list.read-after-write"])
		expect(text).toContain("recall     1/1 injected defects detected")
		expect(text).toContain("clean baseline — no findings against a correct backend")
		expect(text).toContain("3/3 cases passed")
		expect(text).toMatch(/✓ STALE_LIST\s+yes\s+0\s+list\.read-after-write/)
	})

	it("fails a tagged baseline below its shape's floor and names what did not run", () => {
		const floor = COVERAGE_FLOOR.postgrest ?? 0
		const { failures, text } = renderSuite([tagged({ checksRun: IDS.slice(0, floor - 1) })])
		expect(failures).toBe(1)
		expect(text).toContain("VACUOUS")
		expect(text).toContain(`below the ${floor} this shape supports`)
		expect(text).toContain(`did not run: ${IDS.slice(floor - 1).join(", ")}`)
	})

	it("holds an unknown shape to ten checks and lists nothing when all ran", () => {
		const few = renderSuite([tagged({ checksRun: IDS.slice(0, 9) })], "unknown")
		expect(few.text).toContain("below the 10 this shape supports")
		const all = [...IDS, ...IDS].slice(0, 10)
		expect(renderSuite([tagged({ checksRun: all })], "unknown").failures).toBe(0)
	})

	it("fails an untagged baseline that ran almost nothing, without calling it vacuous", () => {
		const { failures, text } = renderSuite([untagged({ checksRun: IDS.slice(0, 9) })])
		expect(failures).toBe(1)
		expect(text).not.toContain("VACUOUS")
	})

	it("fails a noisy baseline and lists its spurious findings", () => {
		const noise = [1, 2, 3, 4, 5].map((n) => finding(`x.n${n}`))
		const { failures, text } = renderSuite([tagged({ spurious: noise })])
		expect(failures).toBe(1)
		expect(text).toContain("noisy")
		expect(text).toContain("spurious: [x.n4] x.n4 fired")
		expect(text).not.toContain("x.n5")
		expect(text).toContain("5 false positive(s) on the correct backend")
	})
})

describe("renderSuite on what a baseline leaves behind", () => {
	it("lets a baseline stay undecided only where its backend and shape allow it", () => {
		const allowance = { "memory:postgrest": ["c.x"], "memory:postgrest:untagged": ["c.y"] }
		const undecided = (label: CaseResult["label"], inconclusive: string[]) =>
			renderSuite([tagged({ inconclusive, label })], "postgrest", "memory", allowance).failures
		expect(undecided("baseline (correct backend)", ["c.x: why"])).toBe(0)
		expect(undecided("baseline (correct backend)", ["c.y: why", "c.xx: why"])).toBe(1)
		expect(undecided("baseline (untagged spec)", ["c.y: why"])).toBe(0)
		expect(renderSuite([tagged({ inconclusive: ["c.x: why"] })], "postgrest", "sqlite", allowance).failures).toBe(1)
	})

	it("fails a baseline that litters, touches, ledgers or leaves undecided", () => {
		const cases: Array<[Partial<CaseResult>, string]> = [
			[{ leaked: 2 }, "left 2 record(s) behind after teardown"],
			[{ bystanders: ["a", "b", "c", "d", "e"] }, "touched 5 record(s) it did not create: a; b; c; d"],
			[{ strayLedger: ["n1"] }, "ledgered 1 id(s) the server never created: n1"],
			[{ missingValues: ["c@note"] }, "would have sent a value it did not have: c@note"],
			[{ unreported: ["n2"] }, "left 1 record(s) behind without reporting them: n2"],
			[{ inconclusive: ["c.x: why"] }, "inconclusive on a correct backend: c.x: why"],
		]
		for (const [extra, line] of cases) {
			const { failures, text } = renderSuite([tagged(extra)])
			expect([failures, text.includes(line)]).toEqual([1, true])
		}
	})
})

describe("renderSuite on a defect", () => {
	it("fails a missed defect, naming what it reported instead", () => {
		const other = caught({ detected: false, findings: [finding("sort.order-is-applied")] })
		expect(renderSuite([other]).text).toContain("missed — reported instead: sort.order-is-applied")
		const silent = caught({ detected: false, findings: [] })
		expect(renderSuite([silent]).text).toContain("missed — reported instead: nothing")
		const broken = renderSuite([caught({ detected: false, error: "boom" })])
		expect(broken.text).toContain("error: boom")
		expect(broken.text).not.toContain("missed")
		expect(broken.text).toContain("NO")
	})

	it("fails a caught defect that also reported something unexplained", () => {
		const { failures, text } = renderSuite([caught({ spurious: [finding("x.extra")] })])
		expect(failures).toBe(1)
		expect(text).toContain("spurious: [x.extra]")
	})

	it("names no check for a defect that expects none", () => {
		expect(renderSuite([caught({ expected: null })]).text).toMatch(/STALE_LIST\s+yes\s+0\s+—/)
	})

	it("reads precision as zero when no baseline ran", () => {
		expect(renderSuite([caught()]).text).toContain("0 false positive(s) on the correct backend")
	})
})

describe("passAnswer", () => {
	it("carries the baselines' checks and every operation the primary check judged", () => {
		const answer = passAnswer(
			[tagged(), untagged(), caught(), caught({ defect: "PATCH_REPLACES", findings: [] })],
			"memory",
			"postgrest",
		)
		expect(answer.failures).toBe(0)
		expect(answer.baselines).toEqual({ tagged: IDS, untagged: IDS.slice(0, 10) })
		expect(answer.primaryOps).toEqual({ STALE_LIST: ["note.list", "note.read"] })
		expect(answer.proven).toEqual(["list.read-after-write"])
	})

	it("skips a primary finding that names no operation", () => {
		const bare = caught({ findings: [finding("list.read-after-write")] })
		expect(passAnswer([bare], "memory", "postgrest").primaryOps).toEqual({})
	})

	it("has empty baselines when a leg ran none", () => {
		expect(passAnswer([], "memory", "postgrest").baselines).toEqual({ tagged: [], untagged: [] })
	})
})

describe("renderUnproven", () => {
	it("passes when every registered check fired", () => {
		expect(renderUnproven(new Set(IDS))).toEqual({
			failures: 0,
			text: `\n  every one of ${IDS.length} registered checks fired on a defect built for it\n`,
		})
	})

	it("fails once per check that never fired", () => {
		const { failures, text } = renderUnproven(new Set(IDS.slice(2)))
		expect(failures).toBe(2)
		expect(text).toContain(
			`✗ 2 registered check(s) never fired on an injected defect:\n      ${IDS[0]}\n      ${IDS[1]}`,
		)
	})
})
