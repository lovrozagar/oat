import { describe, expect, it } from "vitest"
import { parseFilterable, parseSortable } from "./parse-fields.ts"

describe("field lists", () => {
	it("parses filterable strings, structured rows, and junk", () => {
		expect(parseFilterable(undefined)).toEqual({ declared: false, fields: [] })
		expect(parseFilterable("id")).toEqual({ declared: true, fields: [] })
		expect(parseFilterable(["", 1, null, { field: "" }, { field: 2 }, { field: "id" }])).toEqual({
			declared: true,
			fields: [{ field: "id" }],
		})
		expect(
			parseFilterable([
				"name",
				{ field: "id", ops: ["eq", "bogus", 1], type: "nope" },
				{ field: "tags", ops: ["contains"], type: "array" },
				{ field: "empty", ops: [] },
				{ field: "typed", type: 3 },
			]),
		).toEqual({
			declared: true,
			fields: [
				{ field: "name" },
				{ field: "id", ops: ["eq"] },
				{ field: "tags", ops: ["contains"], type: "array" },
				{ field: "empty" },
				{ field: "typed" },
			],
		})
	})

	it("parses sortable strings, structured rows, and junk", () => {
		expect(parseSortable(undefined)).toEqual({ declared: false, fields: [] })
		expect(parseSortable({})).toEqual({ declared: true, fields: [] })
		expect(parseSortable(["", null, { field: "" }, "name"])).toEqual({
			declared: true,
			fields: [{ field: "name" }],
		})
		expect(
			parseSortable([
				{ field: "created_at", nulls: ["first", "nope", 1], type: "date" },
				{ field: "empty", nulls: [] },
				{ field: "bogus", nulls: ["nope"] },
				{ field: "plain" },
			]),
		).toEqual({
			declared: true,
			fields: [
				{ field: "created_at", nulls: ["first"], type: "date" },
				{ field: "empty" },
				{ field: "bogus" },
				{ field: "plain" },
			],
		})
	})

	it("keeps a row's keys in field, type, then ops order", () => {
		const [row] = parseFilterable([{ ops: ["eq"], type: "string", field: "id" }]).fields
		expect(Object.keys(row ?? {})).toEqual(["field", "type", "ops"])
	})
})
