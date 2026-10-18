import { describe, expect, it } from "vitest"
import { shapedEntities } from "../model/shaped.ts"
import { TABLE } from "../model/table.ts"
import { Ids } from "./ids.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("Ids", () => {
	it("issues prefixed string ids from one sequence, with timestamps that follow it", () => {
		const ids = new Ids()
		expect(ids.now()).toBe(1_700_000_000_000)
		expect(ids.next(TABLE)).toBe("table_000001")
		expect(ids.tick()).toBe(2)
		expect(ids.next(TABLE)).toBe("table_000003")
		expect(ids.now()).toBe(1_700_000_003_000)
	})

	it("issues integers for an integer identity", () => {
		const [table] = shapedEntities({ ids: "integer" })
		const ids = new Ids()
		expect([ids.next(table ?? TABLE), ids.next(table ?? TABLE)]).toEqual([1, 2])
	})

	it("issues deterministic, unordered v4 UUIDs for a uuid identity", () => {
		const [table] = shapedEntities({ ids: "uuid" })
		const first = new Ids()
		const second = new Ids()
		const issued = [first.next(table ?? TABLE), first.next(table ?? TABLE)]
		expect(issued.every((id) => UUID.test(String(id)))).toBe(true)
		expect([second.next(table ?? TABLE), second.next(table ?? TABLE)]).toEqual(issued)
		expect(issued[0]).not.toBe(issued[1])
	})

	it("counts what it issues and notes only once serving", () => {
		const ids = new Ids()
		ids.next(TABLE)
		ids.note(TABLE, "before")
		expect(ids.caused).toEqual({})
		ids.serve()
		ids.next(TABLE)
		ids.note(TABLE, 7)
		expect(ids.caused).toEqual({ table: ["table_000002", "7"] })
	})

	it("falls back to a string id when the identity field is not declared", () => {
		const ids = new Ids()
		expect(ids.next({ ...TABLE, identity: "missing" })).toBe("table_000001")
	})
})
