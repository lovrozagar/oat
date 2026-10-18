import { describe, expect, it } from "vitest"
import type { ComparisonOp, FilterNode } from "../query-types.ts"
import { evaluate } from "./evaluate.ts"

const ROWS = [
	{ amount: 10, label: "Alpha", tags: ["red", "blue"] },
	{ amount: 9, label: "beta", note: "Gamma", tags: ["redwood"] },
	{ amount: null, label: null, tags: "red" },
]
const matches = (node: FilterNode): boolean[] => ROWS.map((row) => evaluate(node, row))
const cmp = (op: ComparisonOp, value: number | string, extra: object = {}): FilterNode =>
	({ asText: false, field: "amount", kind: "cmp", nullsMatch: false, op, value, ...extra }) as FilterNode

const search = (mode: "contains" | "prefix", caseSensitive: boolean, token: string): FilterNode => ({
	caseSensitive,
	fields: ["label", "note"],
	kind: "search",
	mode,
	token,
})

const member = (negate: boolean): FilterNode => ({
	asText: false,
	field: "amount",
	kind: "in",
	negate,
	values: [9, 11],
})

const contains = (substring: boolean): FilterNode => ({ field: "tags", kind: "contains", substring, value: "red" })

describe("evaluate: logic", () => {
	it("evaluates constants, groups and null tests", () => {
		const yes: FilterNode = { kind: "const", value: true }
		const no: FilterNode = { kind: "const", value: false }
		expect(matches(yes)).toEqual([true, true, true])
		expect(matches({ children: [yes, no], kind: "and" })).toEqual([false, false, false])
		expect(matches({ children: [yes, no], kind: "or" })).toEqual([true, true, true])
		expect(matches({ field: "note", kind: "isnull", negate: false })).toEqual([true, false, true])
		expect(matches({ field: "note", kind: "isnull", negate: true })).toEqual([false, true, false])
	})
})

describe("evaluate: comparisons", () => {
	it("compares by every operator, a null matching only where the predicate says so", () => {
		expect(matches(cmp("eq", 10))).toEqual([true, false, false])
		expect(matches(cmp("neq", 10, { nullsMatch: true }))).toEqual([false, true, true])
		expect(matches(cmp("gt", 9))).toEqual([true, false, false])
		expect(matches(cmp("gte", 9))).toEqual([true, true, false])
		expect(matches(cmp("lt", 10))).toEqual([false, true, false])
		expect(matches(cmp("lte", 10))).toEqual([true, true, false])
	})

	it("compares as text under the numeric defect", () => {
		expect(matches(cmp("gt", "9", { asText: true }))).toEqual([false, false, false])
		expect(matches(cmp("eq", "10", { asText: true }))).toEqual([true, false, false])
	})

	it("tests membership, a null a member of nothing", () => {
		expect(matches(member(false))).toEqual([false, true, false])
		expect(matches(member(true))).toEqual([true, false, true])
	})
})

describe("evaluate: text", () => {
	it("matches a like pattern against text only", () => {
		expect(
			matches({
				field: "label",
				insensitive: true,
				kind: "like",
				pattern: [{ kind: "text", text: "a" }, { kind: "any" }],
			}),
		).toEqual([true, false, false])
	})

	it("tests array membership exactly, or by substring under the defect, and never on a non-array", () => {
		expect(matches(contains(false))).toEqual([true, false, false])
		expect(matches(contains(true))).toEqual([true, true, false])
	})

	it("searches some field by substring or prefix, folding case unless told not to", () => {
		expect(matches(search("contains", false, "AMM"))).toEqual([false, true, false])
		expect(matches(search("prefix", false, "al"))).toEqual([true, false, false])
		expect(matches(search("prefix", true, "al"))).toEqual([false, false, false])
	})
})
