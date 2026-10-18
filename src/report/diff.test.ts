import { describe, expect, it } from "vitest"
import { diffReports, renderDiff, type SavedFinding, type SavedReport } from "./diff.ts"

const finding = (check: string, entity: string, extra: Partial<SavedFinding> = {}): SavedFinding => ({
	check,
	detail: "status 500",
	entity,
	summary: `${check} on ${entity}`,
	verdict: "BACKEND_BUG",
	...extra,
})

const scope = (operations: Array<[string | undefined, string]>): NonNullable<SavedReport["scope"]> => ({
	operations: operations.map(([operationId, status]) =>
		operationId === undefined ? { status } : { operationId, status },
	),
})

describe("diffReports", () => {
	it("sorts root causes into new, fixed and persisting by their key, ordered by check and entity", () => {
		const a: SavedReport = {
			findings: [
				finding("b-check", "note", { operations: ["op2", "op1"] }),
				finding("a-check", "tag"),
				finding("gap", "note", { verdict: "COVERAGE_GAP" }),
			],
		}
		const b: SavedReport = {
			findings: [
				finding("b-check", "note", { operations: ["op1", "op2"], summary: "same root cause" }),
				finding("z-check", "tag"),
				finding("z-check", "note"),
				finding("blocked", "note", { verdict: "BLOCKED" }),
			],
		}
		const diff = diffReports(a, b)
		expect(diff.new.map(({ check, entity }) => `${check}/${entity}`)).toEqual(["z-check/note", "z-check/tag"])
		expect(diff.fixed.map(({ check }) => check)).toEqual(["a-check"])
		expect(diff.persisting.map(({ summary }) => summary)).toEqual(["same root cause"])
		expect(diff.coverage).toBeNull()
		expect(diff.versions).toEqual({})
	})

	it("lists operations whose status changed, absent on one side included", () => {
		const a: SavedReport = {
			findings: [],
			scope: scope([
				["listNotes", "tested"],
				["getNote", "tested"],
				["gone", "tested"],
				[undefined, "tested"],
			]),
			targetVersion: { value: "1.0" },
		}
		const b: SavedReport = {
			findings: [],
			scope: scope([
				["listNotes", "tested"],
				["getNote", "failed"],
				["added", "skipped"],
			]),
			targetVersion: { error: "unreachable" },
		}
		expect(diffReports(a, b)).toMatchObject({
			coverage: [
				{ from: "absent", operationId: "added", to: "skipped" },
				{ from: "tested", operationId: "getNote", to: "failed" },
				{ from: "tested", operationId: "gone", to: "absent" },
			],
			versions: { a: "1.0" },
		})
		expect(diffReports(b, a).versions).toEqual({ b: "1.0" })
	})

	it("cannot compare coverage when only one report has a scope", () => {
		expect(diffReports({ findings: [], scope: scope([]) }, { findings: [] }).coverage).toBeNull()
	})
})

describe("renderDiff", () => {
	it("prints the versions, the counts, each non-empty section and the coverage changes", () => {
		const text = renderDiff({
			coverage: [{ from: "tested", operationId: "getNote", to: "failed" }],
			fixed: [],
			new: [finding("a-check", "note")],
			persisting: [finding("b-check", "tag")],
			versions: { b: "2.0" },
		})
		expect(text).toBe(
			[
				"",
				"  target  ? → 2.0",
				"  1 new · 0 fixed · 1 persisting",
				"",
				"  NEW",
				`    ${"a-check".padEnd(40)} note — a-check on note`,
				"",
				"  PERSISTING",
				`    ${"b-check".padEnd(40)} tag — b-check on tag`,
				"",
				"  COVERAGE",
				`    ${"getNote".padEnd(40)} tested → failed`,
				"",
				"",
			].join("\n"),
		)
	})

	it("names the first version alone, and says when coverage cannot be compared", () => {
		const text = renderDiff({ coverage: null, fixed: [], new: [], persisting: [], versions: { a: "1.0" } })
		expect(text).toBe(
			[
				"",
				"  target  1.0 → ?",
				"  0 new · 0 fixed · 0 persisting",
				"",
				"  coverage not comparable: a report has no scope",
				"",
				"",
			].join("\n"),
		)
	})

	it("prints no version line and no coverage section when there is nothing to say", () => {
		const text = renderDiff({ coverage: [], fixed: [finding("a", "b")], new: [], persisting: [], versions: {} })
		expect(text).toBe(
			["", "  0 new · 1 fixed · 0 persisting", "", "  FIXED", `    ${"a".padEnd(40)} b — a on b`, "", ""].join("\n"),
		)
	})
})
