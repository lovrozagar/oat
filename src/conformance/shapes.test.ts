import { describe, expect, it } from "vitest"
import { SHAPES } from "../reference/shapes/catalog.ts"
import type { Finding } from "../runtime/finding.ts"
import { inProcess, type Via } from "./harness/launch.ts"
import type { CaseResult } from "./matrix/cases.ts"
import { defectsFor } from "./matrix/defects.ts"
import {
	type CleanRun,
	cleanRunProblems,
	judgeShape,
	recallBehind,
	recallDefects,
	recallProblems,
	renderShapeSuite,
	SHAPE_NAMES,
	type ShapeCase,
	shapeReference,
	shapeTarget,
	waitingRecall,
} from "./shapes.ts"

/* A reference that will not start. */
const refusing: Via = { ...inProcess, launch: () => Promise.reject(new Error("no reference")) }

function finding(check: string, verdict: Finding["verdict"] = "BACKEND_BUG"): Finding {
	return { check, detail: "", entity: "widget", evidence: [], summary: `${check} broke`, verdict }
}

describe("the shape catalogue", () => {
	it("names every shape, in order, and targets the default dialect", () => {
		expect(SHAPE_NAMES).toEqual(SHAPES.map((named) => named.name))
		expect(shapeTarget("sqlite", inProcess)).toEqual({ backend: "sqlite", dialect: "postgrest", via: inProcess })
	})
})

describe("shapeReference and judgeShape", () => {
	const target = shapeTarget("memory", inProcess)

	it("holds a shape to the checks the default shape runs, short of those it cannot run", async () => {
		const reference = await shapeReference(target)
		expect(reference).toEqual(expect.arrayContaining(["list.read-after-write"]))
		const held = ["no.such-check", "pagination.has-more-is-accurate"]
		expect(await judgeShape(target, "page-total", held)).toEqual({
			expected: undefined,
			label: "shape:page-total",
			problems: ["1 check(s) stopped applying: no.such-check"],
			why: "page numbers and a total, with no more-pages flag",
		})
	}, 120_000)

	it("has no reference when the default shape cannot run, and reports a shape that threw", async () => {
		const unreachable = shapeTarget("memory", refusing)
		expect(await shapeReference(unreachable)).toBeNull()
		const judged = await judgeShape(unreachable, "uuid-ids", null)
		expect(judged.problems).toEqual(["threw: no reference"])
	})

	it("refuses a shape it does not know", async () => {
		await expect(judgeShape(target, "no-such-shape", null)).rejects.toThrow('no shape "no-such-shape"')
	})
})

describe("cleanRunProblems", () => {
	it("finds nothing wrong with a quiet run that left the records as they were", () => {
		const quiet: CleanRun = {
			after: { widget: [{ id: "w1" }] },
			before: { widget: [{ id: "w1" }] },
			created: {},
			result: { checksRun: ["a.b"], findings: [finding("x.y", "COVERAGE_GAP")], inconclusive: [], teardown: null },
		}
		expect(cleanRunProblems(quiet, new Set(["a.b"]), {})).toEqual([])
		expect(cleanRunProblems(quiet, undefined, {})).toEqual([])
	})

	it("lists what the run reported, what it did to the records, and the checks it stopped running", () => {
		const unidentified = {
			entity: "widget",
			method: "POST",
			operationId: "widget.create",
			seq: 7,
			status: 201,
			url: "",
		}
		const noisy: CleanRun = {
			after: { widget: [{ id: "w1", name: "changed" }, { id: "w9" }] },
			before: { widget: [{ id: "w1", name: "kept" }, { id: "w2" }] },
			created: { widget: ["w9"] },
			result: {
				checksRun: [],
				findings: [finding("sort.order-is-applied")],
				inconclusive: [{ check: "a.b", entity: "widget", reason: "one row" }],
				teardown: {
					failed: [],
					records: [{ entity: "widget", id: "w5", principal: "alpha", removed: true }],
					removed: 1,
					unidentified: [unidentified],
					unsupported: [],
				},
			},
		}
		expect(cleanRunProblems(noisy, new Set(["c.d", "e.f"]), { "e.f": "no cursor" })).toEqual([
			"BACKEND_BUG [sort.order-is-applied] widget: sort.order-is-applied broke",
			"inconclusive [a.b] widget: one row",
			"left a record it could not identify: widget.create → 201 (#7)",
			"left 1 record(s) behind: widget w9",
			"touched 2 record(s) it did not create: widget w1 changed name; widget w2 deleted",
			"ledgered 1 id(s) the server never created: widget w5",
			"1 check(s) stopped applying: c.d",
		])
	})
})

/* The store minted apikey_000017; the reference created it, and teardown never ledgered it. */
const minted = (teardown: CleanRun["result"]["teardown"]): CleanRun => ({
	after: { widget: [] },
	before: { widget: [] },
	created: { "api-key": ["apikey_000017"] },
	result: { checksRun: [], findings: [], inconclusive: [], teardown },
})
const torn = (failed: NonNullable<CleanRun["result"]["teardown"]>["failed"]) => ({
	failed,
	records: [],
	removed: 0,
	unidentified: [],
	unsupported: [],
})

describe("cleanRunProblems on what the credential store issued", () => {
	it("stays silent on a key the store minted and revokeAll revoked: created, never ledgered, not alive", () => {
		expect(cleanRunProblems(minted(torn([])), undefined, {})).toEqual([])
	})

	it("reports a minted key revokeAll failed to revoke, as the unremovable credential record it is", () => {
		const failed = [
			{ entity: "credential", id: "alpha/apiKey", principal: "alpha", reason: "revoke apiKey.revoke answered 500" },
		]
		expect(cleanRunProblems(minted(torn(failed)), undefined, {})).toEqual([
			"could not remove credential alpha/apiKey: revoke apiKey.revoke answered 500",
		])
	})
})

describe("renderShapeSuite", () => {
	const clean: ShapeCase = { expected: undefined, label: "shape:uuid-ids", problems: [], why: "uuid ids" }
	const known: ShapeCase = { expected: "no cursor yet", label: "shape:cursor-only", problems: ["x"], why: "cursors" }
	const fixed: ShapeCase = { expected: "was broken", label: "shape:page-total", problems: [], why: "pages" }
	const broken: ShapeCase = {
		expected: undefined,
		label: "shape:path-prefix",
		problems: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
		why: "mounted under /api",
	}

	it("passes a clean case and a known failure, and fails a fixed entry and a new failure", () => {
		const { failures, text } = renderShapeSuite([clean, known, fixed, broken])
		expect(failures).toBe(2)
		expect(text.split("\n")).toEqual([
			"",
			"  case                                           result",
			`  ${"─".repeat(73)}`,
			"  ✓ shape:uuid-ids               clean — uuid ids",
			"  ✓ shape:cursor-only            known failure — no cursor yet",
			"  ✗ shape:page-total             now passes — remove it from expected-failures.ts",
			"  ✗ shape:path-prefix            mounted under /api",
			"      p1",
			"      p2",
			"      p3",
			"      p4",
			"      p5",
			"      p6",
			"      … 2 more",
			"",
			"  2/4 cases as expected · 1 known failure(s)",
			"",
		])
	})

	it("leaves passing cases out when quiet, and lists six problems without a tail", () => {
		const six = { ...broken, problems: broken.problems.slice(0, 6) }
		const { text } = renderShapeSuite([clean, six], true)
		expect(text).not.toContain("clean —")
		expect(text).not.toContain("more")
		expect(text).toContain("      p6")
	})
})

describe("recall behind a shape", () => {
	it("draws every defect the default dialect can exhibit, short of the shape's own exclusions, plus its own", () => {
		const defects = recallDefects("memory", "client-ids")
		expect(defects).toEqual(expect.arrayContaining(["STALE_LIST", "CLIENT_ID_IGNORED", "CLIENT_ID_OVERWRITES"]))
		expect(defects).not.toContain("CREATE_DROPS_FIELD")
		expect(recallDefects("memory", "uuid-ids")).toEqual(defectsFor("memory", "postgrest"))
		expect(recallDefects("memory", "no-such-shape")).toEqual([])
	})

	it("waits on a shape that does not run clean yet", () => {
		const shape: ShapeCase = { expected: "later", label: "shape:cursor-only", problems: ["x"], why: "cursors" }
		expect(waitingRecall(shape)).toEqual({
			expected: "later",
			label: "recall:cursor-only",
			problems: ["waits for shape:cursor-only, which does not run clean yet"],
			why: "cursors",
		})
	})

	it("judges each defect behind the shape, and reports one it could not run", async () => {
		const target = shapeTarget("memory", inProcess)
		expect(await recallBehind(target, "uuid-ids", ["STALE_LIST"])).toEqual([
			{ expected: undefined, label: "recall:uuid-ids:STALE_LIST", problems: [], why: "STALE_LIST behind uuid-ids" },
		])
		const [failed] = await recallBehind(shapeTarget("memory", refusing), "uuid-ids", ["STALE_LIST"])
		expect(failed?.problems).toEqual(["error: no reference"])
	}, 120_000)
})

describe("recallProblems", () => {
	const base: CaseResult = {
		checksRun: [],
		defect: "ORDER_IGNORED",
		detected: false,
		entitiesTested: [],
		expected: "sort.order-is-applied",
		findings: [],
		label: "recall:uuid-ids:ORDER_IGNORED",
		spurious: [],
	}

	it("names a miss, and what fired instead", () => {
		expect(recallProblems(base)).toEqual(["missed sort.order-is-applied — reported instead: nothing"])
		const fired = { ...base, findings: [finding("a.b"), finding("c.d", "COVERAGE_GAP")] }
		expect(recallProblems(fired)).toEqual(["missed sort.order-is-applied — reported instead: a.b"])
	})

	it("lists the first few spurious findings, missing values and unreported leftovers", () => {
		const noisy: CaseResult = {
			...base,
			detected: true,
			missingValues: ["a@widget", "b@widget", "c@widget", "d@widget"],
			spurious: [finding("a.b"), finding("c.d"), finding("e.f"), finding("g.h")],
			unreported: ["widget w1", "widget w2", "widget w3", "widget w4", "widget w5"],
		}
		expect(recallProblems(noisy)).toEqual([
			"spurious [a.b] widget: a.b broke",
			"spurious [c.d] widget: c.d broke",
			"spurious [e.f] widget: e.f broke",
			"would have sent a value it did not have: a@widget",
			"would have sent a value it did not have: b@widget",
			"would have sent a value it did not have: c@widget",
			"left 5 record(s) behind without reporting them: widget w1; widget w2; widget w3; widget w4",
		])
		expect(recallProblems({ ...noisy, missingValues: [], spurious: [], unreported: [] })).toEqual([])
	})
})
