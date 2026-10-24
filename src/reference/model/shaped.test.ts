import { describe, expect, it } from "vitest"
import { ENTITIES } from "./entities.ts"
import { shapedEntities } from "./shaped.ts"
import { PHONE_PATTERN, STRING_GUARD } from "./string-guard.ts"
import type { EntityDef } from "./types.ts"

const field = (entity: EntityDef | undefined, name: string) =>
	entity?.fields.find((candidate) => candidate.name === name)

describe("shapedEntities", () => {
	it("serves the model as declared under an empty shape, as copies", () => {
		const entities = shapedEntities({})
		expect(entities).toEqual(ENTITIES)
		expect(entities[0]).not.toBe(ENTITIES[0])
		expect(entities[0]?.fields[1]).not.toBe(ENTITIES[0]?.fields[1])
	})

	it("gives every identity and every parent link the shape's id format", () => {
		const [table, row] = shapedEntities({ ids: "uuid" })
		expect(field(table, "id")).toMatchObject({ format: "uuid", type: "string" })
		expect(field(row, "table_id")).toMatchObject({ format: "uuid", type: "string" })
		const [integerTable] = shapedEntities({ ids: "integer" })
		expect(field(integerTable, "id")?.type).toBe("integer")
		expect(field(integerTable, "id")?.format).toBeUndefined()
	})

	it("renames the identity of every entity but the job, whose poll route is keyed on id", () => {
		const [table, row, job] = shapedEntities({ identityField: "ID" })
		expect([table?.identity, row?.identity, job?.identity]).toEqual(["ID", "ID", "id"])
		expect(shapedEntities({ identityField: "id" })).toEqual(ENTITIES)
	})

	it("lets the table's shape decide its unique sets and leaves the others' alone", () => {
		const [table, row] = shapedEntities({ clientIds: { max: 5, min: 1 } })
		expect(table?.unique).toEqual([["name"], ["id"]])
		expect("unique" in (row as EntityDef)).toBe(false)
		expect(field(table, "id")).toMatchObject({ maximum: 5, required: true })
	})

	it("never leaks one server's shape into another's", () => {
		shapedEntities({ ids: "uuid", richSchema: true, tableKey: "slug" })
		expect(shapedEntities({})).toEqual(ENTITIES)
	})
})

describe("shapedEntities under the string guard", () => {
	it("guards every written string of every entity, and gives the table a phone with a pattern of its own", () => {
		const entities = shapedEntities({ stringGuard: true })
		const table = entities.find((entity) => entity.name === "table")
		expect(field(table, "name")?.patterns).toEqual([STRING_GUARD])
		expect(field(table, "id")?.patterns).toBeUndefined()
		expect(field(table, "phone")).toMatchObject({
			minLength: 7,
			nullable: true,
			patterns: [PHONE_PATTERN, STRING_GUARD],
		})
		for (const entity of entities) {
			const written = entity.fields.filter((one) => one.type === "string" && one.generated !== true)
			for (const one of written) expect(one.patterns, `${entity.name}.${one.name}`).toContain(STRING_GUARD)
		}
	})
})
