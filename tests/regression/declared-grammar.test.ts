import { describe, expect, it } from "vitest"
import { filterTerm } from "../../src/spec/conventions/filter.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { applyGrammarOverrides } from "../../src/spec/grammar-overrides.ts"
import { report } from "../../src/report/console/report.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * A grammar oat cannot infer is declared: on the list operation's `x-query.grammar`, or in config
 * as `query.grammar` for every endpoint and `entities.<name>.query.grammar` for one entity. Config
 * outranks the document, and an entity outranks the whole run.
 */

const TEMPLATE = {
	conj: { and: "and" },
	ops: { eq: "eq", neq: "ne" },
	term: "{conj}_{field}_{op}_{value}",
}

function model(grammar?: unknown) {
	const doc = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/notes": {
				get: {
					operationId: "notes.list",
					parameters: [{ in: "query", name: "filter", schema: { type: "string" } }],
					responses: { "200": { description: "ok" } },
					"x-entity": { action: "list", name: "note" },
					...(grammar === undefined ? {} : { "x-query": { grammar } }),
				},
			},
		},
	} as unknown as OpenApiDocument
	return buildModel(dereference(doc).doc)
}

const conventionsOf = (built: ReturnType<typeof model>) => {
	const op = built.byOperationId.get("notes.list")
	if (op === undefined) throw new Error("no list operation")
	return op.conventions
}
const queryGaps = (built: ReturnType<typeof model>) =>
	built.gaps.gaps.filter((gap) => gap.tag === "x-query").map((gap) => gap.detail)

describe("x-query.grammar as a template", () => {
	it("is the grammar every term is written in", () => {
		const built = model(TEMPLATE)
		expect(queryGaps(built)).toEqual([])
		const conventions = conventionsOf(built)
		expect(conventions.grammar).toBe("template")
		expect(filterTerm(conventions, "Qty", "neq", 2)).toEqual({ filter: "and_Qty_ne_2" })
	})

	it("is a gap naming the bad key when it cannot be read, and oat falls back to inference", () => {
		const built = model({ ...TEMPLATE, ops: { approx: "~" } })
		expect(queryGaps(built).some((detail) => detail.includes('"grammar"') && detail.includes("ops.approx"))).toBe(true)
		expect(conventionsOf(built).grammar).not.toBe("template")
	})

	it("writes no filter term at all while the expression's grammar is unrecognised", () => {
		/* Guessing one parameter per field would send parameters the document never declared and
		 * read the backend ignoring them as a defect. */
		const conventions = conventionsOf(model())
		expect(conventions.grammar).toBe("unrecognised")
		expect(filterTerm(conventions, "Qty", "eq", 2)).toBeNull()
		expect(conventionsOf(model({ ...TEMPLATE, ops: { approx: "~" } })).grammar).toBe("unrecognised")
	})

	it("names the template form when oat cannot recognise a filter expression", () => {
		expect(queryGaps(model()).some((detail) => detail.includes("{ term:"))).toBe(true)
	})
})

describe("config grammars", () => {
	it("outrank the document, and an entity outranks the run", () => {
		const built = model(TEMPLATE)
		applyGrammarOverrides(built, { query: { grammar: "postgrest" } })
		expect(conventionsOf(built).grammar).toBe("postgrest")
		expect(filterTerm(conventionsOf(built), "Qty", "eq", 2)).toEqual({ filter: "Qty.eq.2" })

		applyGrammarOverrides(built, {
			entities: { note: { query: { grammar: { ...TEMPLATE, conj: { and: "all" } } } } },
			query: { grammar: "colon" },
		})
		expect(conventionsOf(built).grammar).toBe("template")
		expect(filterTerm(conventionsOf(built), "Qty", "eq", 2)).toEqual({ filter: "all_Qty_eq_2" })
	})

	it("leave the document's grammar alone when config names none", () => {
		const built = model(TEMPLATE)
		applyGrammarOverrides(built, { entities: { other: { query: { grammar: "postgrest" } } } })
		expect(conventionsOf(built).grammar).toBe("template")
	})

	it("refuse a grammar they cannot read, naming where it is", () => {
		expect(() =>
			applyGrammarOverrides(model(), { entities: { note: { query: { grammar: { term: "{field}" } } } } }),
		).toThrow(/entities\.note\.query\.grammar/)
		/* A config file is read untyped, so a name oat does not know can reach it. */
		const untyped = JSON.parse('{ "query": { "grammar": "sql" } }') as Parameters<typeof applyGrammarOverrides>[1]
		expect(() => applyGrammarOverrides(model(), untyped)).toThrow(/query\.grammar/)
	})
})

describe("doctor", () => {
	it("prints a declared template and the operators it cannot write", () => {
		const text = report.doctor(model(TEMPLATE), [], false).text
		expect(text).toContain("grammar     template {conj}_{field}_{op}_{value}")
		expect(text).toContain("ops eq=eq neq=ne")
		expect(text).toMatch(/cannot write [^\n]*ilike/)
	})

	it("prints no grammar line when none was declared", () => {
		expect(report.doctor(model(), [], false).text).not.toContain("grammar     ")
	})
})

describe("oat plan and doctor", () => {
	const SORT = { asc: "ascending", desc: "descending", join: ",", term: "{field}_{direction}" }
	const withBoth = () => {
		const built = model(TEMPLATE)
		applyGrammarOverrides(built, { query: { sortGrammar: SORT } })
		return built
	}

	it("print the declared filter and sort templates", () => {
		const plan = report.plan(withBoth(), false)
		expect(plan).toContain("template {conj}_{field}_{op}_{value}")
		expect(plan).toContain("template {field}_{direction}")
		const doctor = report.doctor(withBoth(), [], false).text
		expect(doctor).toContain("sort        template {field}_{direction}")
		expect(JSON.parse(report.plan(withBoth(), true)).grammars).toEqual([
			expect.objectContaining({
				entity: "note",
				filter: expect.stringContaining("template"),
				sort: expect.stringContaining("template"),
			}),
		])
	})

	it("print no grammar section when nothing is declared", () => {
		expect(report.plan(model(), false)).not.toContain("declared grammars")
		expect(JSON.parse(report.plan(model(), true))).not.toHaveProperty("grammars")
	})
})
