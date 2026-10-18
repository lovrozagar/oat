import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import { ROW } from "../model/row.ts"
import type { SelectPlan } from "../query-types.ts"
import { context } from "../query/__fixtures__/context.ts"
import { parseFilter } from "../query/filter.ts"
import { likePattern } from "../query/like.ts"
import { parseOrder } from "../query/order.ts"
import { parseSearch } from "../query/search.ts"
import { compileOrder, compileWhere, globText, likeText, type SqlFlavour, type SqlParam } from "./sql-compile.ts"

/* An engine whose spelling is plain to read: each flavour hook names itself in the SQL it writes. */
const plain: SqlFlavour = {
	binary: (expr) => `${expr} BINARY`,
	bind: (args, value) => {
		args.push(value)
		return "?"
	},
	bool: (value) => (value ? 1 : 0),
	column: (_entity, field) => field,
	hasElement: (expr, element, args) => {
		args.push(element)
		return `HAS(${expr}, ?)`
	},
	like: (expr, segments, insensitive, args) => {
		args.push(likeText(segments))
		return `${expr} ${insensitive ? "ILIKE" : "LIKE"} ?`
	},
	position: (expr, needle, caseSensitive, args) => {
		args.push(needle)
		return `${caseSensitive ? "POS" : "IPOS"}(${expr}, ?)`
	},
	random: "RANDOM()",
	toText: (expr) => `TEXT(${expr})`,
}

function where(expression: string, defects: DefectName[] = []): { sql: string; args: SqlParam[] } {
	const args: SqlParam[] = []
	const sql = compileWhere(parseFilter(expression, context(defects, {}, ROW)), ROW, plain, args)
	return { args, sql }
}

function search(q: string, mode: "contains" | "prefix", defects: DefectName[] = []): { sql: string; args: SqlParam[] } {
	const args: SqlParam[] = []
	const node = parseSearch(q, ROW, new DefectSet(defects), mode)
	const sql = node === null ? "" : compileWhere(node, ROW, plain, args)
	return { args, sql }
}

function order(expression: string, plan: Partial<SelectPlan> = {}, defects: DefectName[] = []): string {
	const terms = expression === "" ? [] : parseOrder(expression, context(defects, {}, ROW))
	return compileOrder({ collation: "binary", order: terms, shuffleTies: false, ...plan }, ROW, plain)
}

describe("compileWhere: comparisons", () => {
	it("compares text binary, numbers bare, and booleans as the engine stores them", () => {
		expect(where("label.eq.a")).toEqual({ args: ["a"], sql: "label BINARY = ?" })
		expect(where("amount.gt.10")).toEqual({ args: [10], sql: "amount > ?" })
		expect(where("active.eq.true")).toEqual({ args: [1], sql: "active = ?" })
		expect(where("active.is.false")).toEqual({ args: [0], sql: "active = ?" })
	})

	it("compares the text forms of both sides under NUMERIC_COMPARED_AS_TEXT", () => {
		expect(where("amount.gt.10", ["NUMERIC_COMPARED_AS_TEXT"])).toEqual({ args: ["10"], sql: "TEXT(amount) > ?" })
	})

	it("lets a null satisfy a correct neq, and not one under NEQ_DROPS_NULLS", () => {
		expect(where("note.neq.x")).toEqual({ args: ["x"], sql: "(note BINARY <> ? OR note IS NULL)" })
		expect(where("note.neq.x", ["NEQ_DROPS_NULLS"])).toEqual({ args: ["x"], sql: "note BINARY <> ?" })
	})

	it("writes a constant for a value of the wrong type", () => {
		expect(where("amount.eq.abc")).toEqual({ args: [], sql: "1 = 0" })
		expect(where("amount.neq.abc")).toEqual({ args: [], sql: "1 = 1" })
	})

	it("tests for null in both directions", () => {
		expect(where("note.is.null")).toEqual({ args: [], sql: "note IS NULL" })
		expect(where("note.is.notnull")).toEqual({ args: [], sql: "note IS NOT NULL" })
	})
})

describe("compileWhere: groups, lists and patterns", () => {
	it("joins groups with their own combinator, binding in reading order", () => {
		expect(where("and(label.eq.a,or(amount.lt.1,amount.gte.5))")).toEqual({
			args: ["a", 1, 5],
			sql: "(label BINARY = ? AND (amount < ? OR amount >= ?))",
		})
	})

	it("lists members, lets a null escape nin, and matches by text under the defect", () => {
		expect(where("amount.in.(1,2)")).toEqual({ args: [1, 2], sql: "amount IN (?, ?)" })
		expect(where("amount.nin.(1)")).toEqual({ args: [1], sql: "(amount NOT IN (?) OR amount IS NULL)" })
		expect(where("amount.in.(1)", ["NUMERIC_COMPARED_AS_TEXT"])).toEqual({ args: ["1"], sql: "TEXT(amount) IN (?)" })
	})

	it("matches nothing for an in of no usable member, and everything for such a nin", () => {
		expect(where("amount.in.(x,y)")).toEqual({ args: [], sql: "1 = 0" })
		expect(where("amount.nin.(x)")).toEqual({ args: [], sql: "1 = 1" })
	})

	it("hands a pattern to the engine's matcher, case-sensitive or not", () => {
		expect(where("label.like.a*")).toEqual({ args: ["a%"], sql: "label LIKE ?" })
		expect(where("label.ilike.*b")).toEqual({ args: ["%b"], sql: "label ILIKE ?" })
	})

	it("tests array membership, or the serialised array as text under CONTAINS_MATCHES_SUBSTRING", () => {
		expect(where("tags.contains.red")).toEqual({ args: ["red"], sql: "HAS(tags, ?)" })
		expect(where("tags.contains.red", ["CONTAINS_MATCHES_SUBSTRING"])).toEqual({
			args: ["red"],
			sql: "POS(tags, ?) > 0",
		})
	})

	it("searches every searchable field's text, by prefix or anywhere", () => {
		expect(search("Re", "prefix")).toEqual({
			args: ["Re", "Re"],
			sql: "((IPOS(TEXT(label), ?) = 1 OR IPOS(TEXT(note), ?) = 1))",
		})
		expect(search("Re", "contains", ["SEARCH_CASE_SENSITIVE"])).toEqual({
			args: ["Re", "Re"],
			sql: "((POS(TEXT(label), ?) > 0 OR POS(TEXT(note), ?) > 0))",
		})
	})
})

describe("compileOrder", () => {
	it("writes null placement out, then each term in its direction", () => {
		expect(order("label,amount.desc")).toBe(
			" ORDER BY label IS NULL DESC, label BINARY ASC, amount IS NULL ASC, amount DESC",
		)
	})

	/* A collation on a bigint, double precision or boolean column is an error in Postgres, so
	 * only text columns may carry one — under either collation, including the one
	 * COLLATION_INCONSISTENT switches cursor resolution to. */
	for (const collation of ["binary", "insensitive"] as const) {
		it(`leaves non-text columns bare under ${collation} collation`, () => {
			for (const field of ["amount", "active"]) {
				expect(order(`${field}.nullslast`, { collation })).toBe(` ORDER BY ${field} IS NULL ASC, ${field} ASC`)
			}
		})
	}

	it("applies the collation to text columns", () => {
		expect(order("label.nullslast")).toBe(" ORDER BY label IS NULL ASC, label BINARY ASC")
		expect(order("label.nullslast", { collation: "insensitive" })).toBe(" ORDER BY label IS NULL ASC, LOWER(label) ASC")
	})

	it("sorts a number by its text under SORT_NUMERIC_AS_TEXT", () => {
		expect(order("amount.nullslast", {}, ["SORT_NUMERIC_AS_TEXT"])).toBe(
			" ORDER BY amount IS NULL ASC, TEXT(amount) ASC",
		)
	})

	it("shuffles ties last, and writes no clause for no order", () => {
		expect(order("amount.nullslast", { shuffleTies: true })).toBe(" ORDER BY amount IS NULL ASC, amount ASC, RANDOM()")
		expect(order("", { shuffleTies: true })).toBe(" ORDER BY RANDOM()")
		expect(order("")).toBe("")
	})
})

describe("likeText and globText", () => {
	it("escape the engine's own wildcards in literal text, and spell the grammar's", () => {
		const pattern = likePattern("a\\b%_*?[", true)
		expect(likeText(pattern)).toBe("a\\\\b%_%?[")
		expect(globText(pattern)).toBe("a\\b*?*[?][[]")
		expect(likeText(likePattern("50%_off", false))).toBe("50\\%\\_off")
	})
})
