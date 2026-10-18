import { describe, expect, it } from "vitest"
import { selectTerm } from "./select.ts"
import type { QueryConventions, SelectGrammar } from "./types.ts"

const at = (selectGrammar: SelectGrammar, select?: string): QueryConventions => ({
	envelope: {},
	grammar: "postgrest",
	selectGrammar,
	sortGrammar: "dotted",
	...(select === undefined ? {} : { select }),
})

describe("selectTerm", () => {
	it("is null where the endpoint has no fieldset parameter", () => {
		expect(selectTerm(at("csv"), ["id"], "articles")).toBeNull()
	})

	it("lists the fields under the parameter, putting the resource in a bracketed name", () => {
		expect(selectTerm(at("csv", "select"), ["id", "name"], "articles")).toEqual({ select: "id,name" })
		expect(selectTerm(at("bracketed", "fields"), ["id"], "articles")).toEqual({ "fields[articles]": "id" })
		expect(selectTerm(at("bracketed", "fields[people]"), ["id"], "articles")).toEqual({ "fields[people]": "id" })
	})
})
