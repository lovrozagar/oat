import { describe, expect, it } from "vitest"
import { TABLE } from "./table.ts"
import { TIMESTAMPS } from "./timestamps.ts"

const names = TABLE.fields.map((field) => field.name)

describe("TABLE", () => {
	it("is the project's root collection, named by a server-issued id and unique by name", () => {
		expect(TABLE).toMatchObject({ identity: "id", itemParam: "table_id", parents: ["project_id"], unique: [["name"]] })
		expect(TABLE.collectionPath).toBe("/v1/projects/{project_id}/tables")
		expect(TABLE.itemPath).toBe(`${TABLE.collectionPath}/{table_id}`)
	})

	it("carries the timestamps, a soft-delete tombstone and a count derived from another entity", () => {
		expect(TABLE.fields).toEqual(expect.arrayContaining(TIMESTAMPS))
		expect(TABLE.fields.find((field) => field.name === TABLE.softDeleteField)).toMatchObject({ nullable: true })
		expect(TABLE.fields.find((field) => field.name === "row_count")).toMatchObject({ generated: true })
	})

	it("declares operators only for fields it has, and a default order on a sortable one", () => {
		expect(Object.keys(TABLE.filterCatalog?.opsByField ?? {}).every((field) => names.includes(field))).toBe(true)
		const [field] = TABLE.defaultOrder.split(".")
		expect(TABLE.fields.find((candidate) => candidate.name === field)?.sortable).toBe(true)
		expect(TABLE.filterCatalog).toMatchObject({ aliases: { ne: "neq" }, maxFilterConditions: 20, maxInValues: 100 })
	})
})
