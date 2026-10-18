import { describe, expect, it } from "vitest"
import { fieldsWhere, OVERCLAIMED_FIELD, writableFields } from "./fields.ts"
import { ENTITIES } from "./entities.ts"
import type { EntityDef } from "./types.ts"

const ENTITY: EntityDef = {
	collectionPath: "/things",
	defaultLimit: 10,
	defaultOrder: "id.asc",
	fields: [
		{ generated: true, name: "id", sortable: true, type: "string" },
		{ filterable: true, name: "title", sortable: true, type: "string" },
		{ immutable: true, name: "owner", type: "string" },
		{ createOnly: true, filterable: false, name: "seed", type: "integer" },
	],
	identity: "id",
	itemParam: "thing_id",
	itemPath: "/things/{thing_id}",
	maxLimit: 20,
	name: "thing",
	parents: [],
	plural: "things",
}

describe("fieldsWhere", () => {
	it("names the fields a flag is set on, in declaration order, and no field it is false or absent on", () => {
		expect(fieldsWhere(ENTITY, "sortable")).toEqual(["id", "title"])
		expect(fieldsWhere(ENTITY, "filterable")).toEqual(["title"])
		expect(fieldsWhere(ENTITY, "searchable")).toEqual([])
	})
})

describe("writableFields", () => {
	it("accepts everything but server-set fields at create", () => {
		expect(writableFields(ENTITY, "create").map((field) => field.name)).toEqual(["title", "owner", "seed"])
	})

	it("drops immutable and create-only fields at update", () => {
		expect(writableFields(ENTITY, "update").map((field) => field.name)).toEqual(["title"])
	})
})

describe("OVERCLAIMED_FIELD", () => {
	it("is a field every entity declares", () => {
		for (const entity of ENTITIES) expect(entity.fields.map((field) => field.name)).toContain(OVERCLAIMED_FIELD)
	})
})
