import { describe, expect, it } from "vitest"
import {
	type Draft,
	isRecord,
	nonEmpty,
	placeholders,
	readAnd,
	readConj,
	readEscape,
	readLikeMatches,
	readList,
	readMixed,
	readNull,
	readOps,
	readOr,
} from "./filter-parse-steps.ts"

const TERM = "{conj}_{field}_{op}_{value}"

function draft(raw: Record<string, unknown>, over: Partial<Draft> = {}): Draft {
	const term = typeof raw.term === "string" ? raw.term : TERM
	return {
		and: "repeat",
		escape: {},
		likeMatches: "pattern",
		names: placeholders(term),
		ops: {},
		or: "none",
		param: "{filter}",
		raw,
		term,
		...over,
	}
}

/* What combine reads to, or the error it names. */
function andOf(raw: Record<string, unknown>, param: Draft["param"] = "{filter}") {
	const at = draft(raw, { param })
	return readAnd(at) ?? at.and
}

const andError = (raw: Record<string, unknown>, param: Draft["param"] = "{filter}") => readAnd(draft(raw, { param }))

/* What or reads to, or the error it names. */
function orOf(raw: Record<string, unknown>, over: Partial<Draft> = {}) {
	const at = draft(raw, over)
	return readOr(at) ?? at.or
}

/* What likeMatches reads to, or the error it names. */
function likeOf(raw: Record<string, unknown>) {
	const at = draft(raw)
	return readLikeMatches(at) ?? at.likeMatches
}

describe("helpers", () => {
	it("tells records, non-empty strings and placeholders", () => {
		expect(isRecord({})).toBe(true)
		expect(isRecord([])).toBe(false)
		expect(isRecord(null)).toBe(false)
		expect(nonEmpty("a")).toBe(true)
		expect(nonEmpty("")).toBe(false)
		expect([...placeholders("{field}.{op}.{value}{nope}")]).toEqual(["field", "op", "value"])
	})
})

describe("ops", () => {
	it("reads each operator's token", () => {
		const read = draft({ ops: { eq: "eq", neq: "ne" } })
		expect(readOps(read)).toBeUndefined()
		expect(read.ops).toEqual({ eq: "eq", neq: "ne" })
		expect(readOps(draft({ ops: { eq: "=" }, term: "{field}={value}" }))).toBeUndefined()
	})

	it("names what it cannot read", () => {
		expect(readOps(draft({ ops: [] }))).toBe("ops must map oat operators to the grammar's tokens")
		expect(readOps(draft({ ops: { approx: "~" } }))).toBe(
			"ops.approx is not an operator oat writes (null tests go under null)",
		)
		expect(readOps(draft({ ops: { is: "is" } }))).toContain("ops.is")
		expect(readOps(draft({ ops: { eq: "" } }))).toBe("ops.eq must be a non-empty token")
		expect(readOps(draft({ ops: {} }))).toBe("ops must list at least one operator")
		expect(readOps(draft({ ops: { eq: "=", gt: ">" }, term: "{field}{value}" }))).toBe(
			"term must hold {op} when ops lists several",
		)
	})
})

describe("conj", () => {
	it("reads and, and or when given", () => {
		const both = draft({ conj: { and: "and", or: "or" } })
		expect(readConj(both)).toBeUndefined()
		expect(both.conj).toEqual({ and: "and", or: "or" })
		const andOnly = draft({ conj: { and: "and" } })
		expect(readConj(andOnly)).toBeUndefined()
		expect(andOnly.conj).toEqual({ and: "and" })
		expect(readConj(draft({}, { names: placeholders("{field}{value}") }))).toBeUndefined()
	})

	it("names what it cannot read", () => {
		expect(readConj(draft({ conj: "and" }))).toBe("conj must be { and: token, or?: token }")
		expect(readConj(draft({ conj: { and: "" } }))).toBe("conj must be { and: token, or?: token }")
		expect(readConj(draft({ conj: { and: "and", or: "" } }))).toBe("conj.or must be a non-empty token")
		expect(readConj(draft({}))).toBe("conj must be declared when term holds {conj}")
	})
})

describe("null", () => {
	it("reads the two null terms", () => {
		const read = draft({ null: { is: "{conj}{field}=null", not: "{field}!=null" } }, { conj: { and: "&" } })
		expect(readNull(read)).toBeUndefined()
		expect(read.nullTerms).toEqual({ is: "{conj}{field}=null", not: "{field}!=null" })
		expect(readNull(draft({}))).toBeUndefined()
	})

	it("names what it cannot read", () => {
		expect(readNull(draft({ null: "null" }))).toBe("null must be { is: template, not: template }")
		expect(readNull(draft({ null: { is: "a" } }))).toBe("null must be { is: template, not: template }")
		expect(readNull(draft({ null: { is: "", not: "b" } }))).toBe("null must be { is: template, not: template }")
		expect(readNull(draft({ null: { is: "{value}", not: "b" } }))).toBe("null.is may hold only {conj} and {field}")
		expect(readNull(draft({ null: { is: "a", not: "{op}" } }))).toBe("null.not may hold only {conj} and {field}")
		expect(readNull(draft({ null: { is: "{terms}", not: "b" } }))).toBe("null.is may hold only {conj} and {field}")
		expect(readNull(draft({ null: { is: "{conj}", not: "b" } }))).toBe(
			"conj must be declared when null.is holds {conj}",
		)
	})
})

describe("list", () => {
	it("reads the joiner", () => {
		const read = draft({ list: "," })
		expect(readList(read)).toBeUndefined()
		expect(read.list).toEqual({ close: "", join: ",", open: "" })
		expect(readList(draft({}))).toBeUndefined()
		expect(readList(draft({ list: "" }))).toBe('list must be the joiner for in and nin values, such as ","')
	})
})

describe("combine", () => {
	it("reads repeat, a join or a group, and params for a per-field grammar", () => {
		expect(andOf({})).toBe("repeat")
		expect(andOf({ combine: "repeat" })).toBe("repeat")
		expect(andOf({ combine: { join: ";" } })).toEqual({ join: ";" })
		expect(andOf({ combine: { group: "all({terms})" } })).toEqual({ group: "all({terms})", join: "," })
		expect(andOf({ combine: { group: "all({terms})", join: "|" } })).toEqual({ group: "all({terms})", join: "|" })
		expect(andOf({}, "{field}")).toBe("params")
	})

	it("names what it cannot read", () => {
		expect(andError({ combine: "repeat" }, "{field}")).toBe(
			"combine does not apply when param is {field}: each field is its own parameter",
		)
		expect(andError({ combine: "sometimes" })).toBe('combine must be "repeat", { join: "," } or { group: "…{terms}…" }')
		expect(andError({ combine: { join: "" } })).toBe(
			'combine must be "repeat", { join: "," } or { group: "…{terms}…" }',
		)
		expect(andError({ combine: { group: "" } })).toBe('combine must be a group: { group: "…{terms}…", join?: "," }')
		expect(andError({ combine: { group: "all({field})" } })).toBe(
			"combine.group must hold {terms} and no other placeholder",
		)
		expect(andError({ combine: { group: "{terms}{field}" } })).toBe(
			"combine.group must hold {terms} and no other placeholder",
		)
		expect(andError({ combine: { group: "all({terms})", join: "" } })).toBe("combine.join must be a non-empty string")
	})
})

describe("or", () => {
	it("reads none, terms, or a group", () => {
		expect(orOf({})).toBe("none")
		expect(orOf({ or: "none" })).toBe("none")
		expect(orOf({ or: "terms" }, { conj: { and: "and", or: "or" } })).toBe("terms")
		expect(orOf({ or: { group: "any({terms})" } })).toEqual({ group: "any({terms})", join: "," })
	})

	it("names what it cannot read", () => {
		expect(readOr(draft({ or: "terms" }, { conj: { and: "and" } }))).toBe("or: terms needs conj.or and {conj} in term")
		expect(readOr(draft({ or: "terms", term: "{field}{value}" }, { conj: { and: "and", or: "or" } }))).toBe(
			"or: terms needs conj.or and {conj} in term",
		)
		expect(readOr(draft({ or: "terms" }, { and: "params", conj: { and: "and", or: "or" } }))).toBe(
			"or: terms needs param {filter}",
		)
		expect(readOr(draft({ or: { group: "any({terms})" } }, { param: "{field}" }))).toBe("or needs param {filter}")
		expect(readOr(draft({ or: "sometimes" }))).toBe('or must be a group: { group: "…{terms}…", join?: "," }')
	})
})

describe("mixed, escape and likeMatches", () => {
	it("accepts mixed only as false", () => {
		expect(readMixed(draft({}))).toBeUndefined()
		expect(readMixed(draft({ mixed: false }))).toBeUndefined()
		expect(readMixed(draft({ mixed: true }))).toBe(
			"mixed must be false: oat never assumes how and and or nest in a declared grammar",
		)
	})

	it("reads one-character escapes", () => {
		const read = draft({ escape: { _: "~", "😀": "smile" } })
		expect(readEscape(read)).toBeUndefined()
		expect(read.escape).toEqual({ _: "~", "😀": "smile" })
		expect(readEscape(draft({}))).toBeUndefined()
		expect(readEscape(draft({ escape: "_" }))).toBe("escape must map single characters to replacements")
		expect(readEscape(draft({ escape: { __: "~" } }))).toBe(
			'escape["__"] must map one character to a non-empty replacement',
		)
		expect(readEscape(draft({ escape: { _: "" } }))).toBe(
			'escape["_"] must map one character to a non-empty replacement',
		)
	})

	it("reads likeMatches as pattern by default", () => {
		expect(likeOf({})).toBe("pattern")
		expect(likeOf({ likeMatches: "contains" })).toBe("contains")
		expect(likeOf({ likeMatches: "glob" })).toBe('likeMatches must be "pattern" or "contains"')
	})
})
