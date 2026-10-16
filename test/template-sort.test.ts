import { describe, expect, it } from "vitest"
import { sortKeys, sortTerm, sortTermWithNulls, type QueryConventions } from "../src/spec/conventions.ts"
import { applyGrammarOverrides } from "../src/spec/grammar-overrides.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import { describeSortGrammar, parseSortGrammar } from "../src/spec/sort-render.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/*
 * A sort grammar oat has no name for, declared as a template: `Qty_descending`, several keys
 * joined by a comma or none at all, and a nulls token only when the grammar has one.
 */

const TEMPLATE = { asc: "ascending", desc: "descending", join: ",", term: "{field}_{direction}" }

function parsed(raw: unknown) {
	const result = parseSortGrammar(raw)
	if (!result.ok) throw new Error(result.error)
	return result.spec
}

const conventions = (sortGrammar: QueryConventions["sortGrammar"], sortSpec?: unknown): QueryConventions => ({
	envelope: {},
	grammar: "postgrest",
	selectGrammar: "csv",
	sortGrammar,
	...(sortSpec === undefined ? {} : { sortSpec: parsed(sortSpec) }),
})

describe("a template sort grammar", () => {
	it("writes each key with its own direction tokens", () => {
		const at = conventions("template", TEMPLATE)
		expect(sortTerm(at, "Qty", "desc")).toBe("Qty_descending")
		expect(sortTerm(at, "Qty", "asc")).toBe("Qty_ascending")
		expect(
			sortKeys(at, [
				["Qty", "desc"],
				["Name", "asc"],
			]),
		).toBe("Qty_descending,Name_ascending")
	})

	it("sorts by one key only when it has no joiner", () => {
		const at = conventions("template", { ...TEMPLATE, join: null })
		expect(sortKeys(at, [["Qty", "desc"]])).toBe("Qty_descending")
		expect(
			sortKeys(at, [
				["Qty", "desc"],
				["Name", "asc"],
			]),
		).toBeNull()
	})

	it("writes a nulls token only when it declares one", () => {
		expect(sortTermWithNulls(conventions("template", TEMPLATE), "Qty", "asc", "first")).toBeNull()
		const withNulls = conventions("template", { ...TEMPLATE, nulls: { first: "_nf", last: "_nl" } })
		expect(sortTermWithNulls(withNulls, "Qty", "asc", "last")).toBe("Qty_ascending_nl")
	})

	it("names the key it cannot read", () => {
		for (const [raw, key] of [
			[{ ...TEMPLATE, term: "{field}" }, "term"],
			[{ ...TEMPLATE, asc: "x", desc: "x" }, "desc"],
			[{ ...TEMPLATE, join: "" }, "join"],
			[{ ...TEMPLATE, nulls: { first: "a" } }, "nulls"],
		] as const) {
			const result = parseSortGrammar(raw)
			expect(result.ok, key).toBe(false)
			if (!result.ok) expect(result.error).toContain(key)
		}
	})
})

describe("the named sort grammars", () => {
	it("join several keys with a comma, as before", () => {
		const keys = [
			["a", "asc"],
			["b", "desc"],
		] as const
		expect(sortKeys(conventions("dotted"), keys)).toBe("a.asc,b.desc")
		expect(sortKeys(conventions("prefixed"), keys)).toBe("a,-b")
		expect(sortKeys(conventions("colon"), keys)).toBe("a:asc,b:desc")
		expect(sortKeys(conventions("spaced"), keys)).toBe("a asc,b desc")
	})
})

function model(sortGrammar?: unknown) {
	const doc = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/notes": {
				get: {
					operationId: "notes.list",
					parameters: [{ in: "query", name: "sort", schema: { type: "string" } }],
					responses: { "200": { description: "ok" } },
					"x-entity": { action: "list", name: "note" },
					...(sortGrammar === undefined ? {} : { "x-query": { sortGrammar } }),
				},
			},
		},
	} as unknown as OpenApiDocument
	return buildModel(dereference(doc).doc)
}
const sortOf = (built: ReturnType<typeof model>) => {
	const op = built.byOperationId.get("notes.list")
	if (op === undefined) throw new Error("no list operation")
	return op.conventions
}

describe("a declared sort grammar", () => {
	it("comes from x-query.sortGrammar, and config outranks it", () => {
		const built = model(TEMPLATE)
		expect(built.gaps.gaps.filter((gap) => gap.tag === "x-query")).toEqual([])
		expect(sortTerm(sortOf(built), "Qty", "desc")).toBe("Qty_descending")
		applyGrammarOverrides(built, { entities: { note: { query: { sortGrammar: "prefixed" } } } })
		expect(sortTerm(sortOf(built), "Qty", "desc")).toBe("-Qty")
	})

	it("is a gap naming the bad key when the document's cannot be read", () => {
		const details = model({ ...TEMPLATE, term: "{field}" })
			.gaps.gaps.filter((gap) => gap.tag === "x-query")
			.map((gap) => gap.detail)
		expect(details.some((detail) => detail.includes('"sortGrammar"') && detail.includes("term"))).toBe(true)
	})
})

/*
 * Some APIs take several sort keys only as the sort parameter repeated, in order:
 * `?sort=A_descending&sort=B_ascending`. `join: "repeat"` declares it; the keys then travel as a
 * list the client sends one parameter each, never joined into one value.
 */
describe("join: repeat", () => {
	const repeated = parseSortGrammar({
		asc: "ascending",
		desc: "descending",
		join: "repeat",
		term: "{field}_{direction}",
	})

	it("parses", () => {
		expect(repeated.ok).toBe(true)
	})

	it("renders several keys as a list, in order, and one key as a value", () => {
		if (!repeated.ok) throw new Error("did not parse")
		const conventions = { sortGrammar: "template", sortSpec: repeated.spec } as unknown as QueryConventions
		expect(
			sortKeys(conventions, [
				["A", "desc"],
				["B", "asc"],
			]),
		).toEqual(["A_descending", "B_ascending"])
		expect(sortKeys(conventions, [["A", "desc"]])).toBe("A_descending")
	})

	it("is described as repeated", () => {
		if (!repeated.ok) throw new Error("did not parse")
		expect(describeSortGrammar(repeated.spec)).toContain("repeated")
	})
})
