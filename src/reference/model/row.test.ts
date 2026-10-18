import { describe, expect, it } from "vitest"
import { ROW } from "./row.ts"

describe("ROW", () => {
	it("lives under a table and embeds that table's name and status", () => {
		expect(ROW.parents).toEqual(["project_id", "table_id"])
		expect(ROW.relations).toEqual({ table: { entity: "table", fields: ["name", "status"], via: "table_id" } })
	})

	it("holds an array whose elements include one that prefixes another, so substring matching shows", () => {
		const tags = ROW.fields.find((field) => field.name === "tags")
		expect(tags).toMatchObject({ filterable: true, type: "array" })
		expect(tags?.items).toEqual(expect.arrayContaining(["red", "redwood"]))
	})

	it("caps a page below its default size, so the ceiling is observable", () => {
		expect(ROW.maxLimit).toBeLessThan(ROW.defaultLimit)
		expect(ROW.fields.map((field) => field.type)).toEqual(expect.arrayContaining(["number", "boolean", "array"]))
	})
})
