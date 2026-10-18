import { describe, expect, it } from "vitest"
import { TABLE } from "./table.ts"
import { shapeTable } from "./table-shape.ts"
import type { FieldDef } from "./types.ts"

const fresh = (): FieldDef[] => TABLE.fields.map((field) => ({ ...field }))
const named = (fields: FieldDef[], name: string): FieldDef | undefined => fields.find((field) => field.name === name)

describe("shapeTable", () => {
	it("changes nothing for a shape that does not touch the table", () => {
		const fields = fresh()
		expect(shapeTable(TABLE, fields, {})).toBe(TABLE.unique)
		expect(fields).toEqual(TABLE.fields)
	})

	it("makes the id a bounded, required integer the client chooses, and unique", () => {
		const fields = fresh()
		const unique = shapeTable(TABLE, fields, { clientIds: { max: 9, min: 1 } })
		expect(named(fields, "id")).toMatchObject({
			generated: false,
			maximum: 9,
			minimum: 1,
			required: true,
			type: "integer",
		})
		expect(unique).toEqual([["name"], ["id"]])
	})

	it("derives a required slug from the name and declares nothing unique", () => {
		const fields = fresh()
		const unique = shapeTable(TABLE, fields, { clientIds: { max: 9, min: 1 }, tableKey: "slug" })
		expect(named(fields, "slug")).toMatchObject({ generated: true, maxLength: 128, required: true })
		expect(unique).toEqual([])
	})

	it("adds each optional field in the order the document lists them", () => {
		const fields = fresh()
		shapeTable(TABLE, fields, { largeRecords: true, richSchema: true, specLayout: true, writeOnlyField: true })
		expect(fields.slice(TABLE.fields.length).map((field) => field.name)).toEqual([
			"secret",
			"due_at",
			"weight",
			"schema_version",
			"start",
			"end",
			"padding",
			"tree",
		])
		expect(named(fields, "secret")).toMatchObject({ writeOnly: true })
		expect(named(fields, "tree")).toMatchObject({ nullable: true, ref: "TreeNode" })
	})
})
