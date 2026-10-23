import { describe, expect, it } from "vitest"
import { renameIdentity } from "./identity.ts"
import { ROW } from "./row.ts"
import { TABLE } from "./table.ts"

describe("renameIdentity", () => {
	it("renames the identity field, its operator catalog entry and its unique sets", () => {
		const renamed = renameIdentity({ ...TABLE, unique: [["name"], ["id", "name"]] }, "ID")
		expect(renamed.identity).toBe("ID")
		expect(renamed.fields.map((field) => field.name)).toContain("ID")
		expect(renamed.fields.map((field) => field.name)).not.toContain("id")
		expect(Object.keys(renamed.filterCatalog?.opsByField ?? {})).toContain("ID")
		expect(renamed.filterCatalog?.opsByField?.["ID"]).toBe(TABLE.filterCatalog?.opsByField?.["id"])
		expect(renamed.filterCatalog?.aliases).toEqual({ ne: "neq" })
		expect(renamed.unique).toEqual([["name"], ["ID", "name"]])
	})

	it("adds no catalog or unique set to an entity that declares neither", () => {
		const renamed = renameIdentity(ROW, "key")
		expect(renamed.identity).toBe("key")
		expect("filterCatalog" in renamed).toBe(false)
		expect("unique" in renamed).toBe(false)
	})

	it("keeps an entity whose catalog has no per-field operators as it was there", () => {
		const catalog = { maxInValues: 3 }
		const renamed = renameIdentity({ ...TABLE, filterCatalog: catalog }, "ID")
		expect(renamed.filterCatalog).toBe(catalog)
	})

	it("leaves the original untouched and its other fields shared", () => {
		const renamed = renameIdentity(TABLE, "ID")
		expect(TABLE.identity).toBe("id")
		expect(renamed.fields[2]).toBe(TABLE.fields[2])
	})
})
