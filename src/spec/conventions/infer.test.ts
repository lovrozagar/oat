import { describe, expect, it } from "vitest"
import { query } from "../__fixtures__/documents.ts"
import { inferGrammar, inferSelectGrammar, inferSortGrammar } from "./infer.ts"
import type { JsonSchema } from "../types.ts"

const described = (name: string, description: unknown) => query(name, { type: "string" }, { description })
const exampled = (name: string, schema: JsonSchema) => query(name, { type: "string", ...schema })

describe("inferGrammar", () => {
	it("reads postgrest from its name, an instance, or its schema written out", () => {
		expect(inferGrammar(described("filter", "A PostgREST filter"))).toBe("postgrest")
		expect(inferGrammar(exampled("filter", { example: "name.eq.x" }))).toBe("postgrest")
		expect(inferGrammar(exampled("filter", { examples: [1, "price.gte.10"] }))).toBe("postgrest")
		expect(inferGrammar(described("filter", "written as field.op.value"))).toBe("postgrest")
	})

	it("reads the colon grammar, and defaults to equality", () => {
		expect(inferGrammar(described("filter", "e.g. status=eq:active"))).toBe("colon")
		expect(inferGrammar(described("filter", 5))).toBe("equality")
		expect(inferGrammar({ in: "query", name: "filter" })).toBe("equality")
		expect(inferGrammar(undefined)).toBe("equality")
	})
})

describe("inferSortGrammar", () => {
	it("reads each direction spelling from what the document shows", () => {
		expect(inferSortGrammar(exampled("sort", { example: "name.desc" }))).toBe("dotted")
		expect(inferSortGrammar(described("sort", "name:asc"))).toBe("colon")
		expect(inferSortGrammar(exampled("sort", { examples: ["name desc"] }))).toBe("spaced")
		expect(inferSortGrammar(described("sort", "-created_at sorts descending"))).toBe("prefixed")
		expect(inferSortGrammar(described("sort", "sort=-name"))).toBe("prefixed")
	})

	it("defaults to the dotted form", () => {
		expect(inferSortGrammar(described("sort", "a well-known order - nothing more"))).toBe("dotted")
		expect(inferSortGrammar(undefined)).toBe("dotted")
	})
})

describe("inferSelectGrammar", () => {
	it("reads JSON:API's bracketed form from the name or the description", () => {
		expect(inferSelectGrammar(query("fields[articles]"))).toBe("bracketed")
		expect(inferSelectGrammar(described("fields", "as fields[type]=id,name"))).toBe("bracketed")
	})

	it("defaults to a comma-separated list", () => {
		expect(inferSelectGrammar(described("fields", "id,name"))).toBe("csv")
		expect(inferSelectGrammar(described("fields", 1))).toBe("csv")
		expect(inferSelectGrammar(undefined)).toBe("csv")
	})
})
