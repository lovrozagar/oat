import { describe, expect, it } from "vitest"
import type { EntityDef } from "../model/types.ts"
import type { SelectPlan } from "../query-types.ts"
import { MemoryStore } from "./memory.ts"

const ITEM = { fields: [], identity: "id", name: "item" } as unknown as EntityDef
const OTHER = { fields: [], identity: "id", name: "other" } as unknown as EntityDef

const ALL: SelectPlan = { collation: "binary", order: [], shuffleTies: false, where: { kind: "const", value: true } }

async function seeded(): Promise<MemoryStore> {
	const store = new MemoryStore()
	for (const id of ["a", "b", "c"]) await store.insert(ITEM, { id, rank: id === "b" ? 1 : 2 })
	return store
}

const ids = (rows: Array<Record<string, unknown>>): unknown[] => rows.map((row) => row.id)

describe("MemoryStore", () => {
	it("keeps rows per entity, by identity, and hands out copies", async () => {
		const store = await seeded()
		const read = await store.byId(ITEM, "a")
		expect(read).toEqual({ id: "a", rank: 2 })
		if (read !== null) read.rank = 99
		expect(await store.byId(ITEM, "a")).toEqual({ id: "a", rank: 2 })
		expect(await store.byId(OTHER, "a")).toBeNull()
	})

	it("merges a patch into an existing row, and answers null for a missing one", async () => {
		const store = await seeded()
		expect(await store.update(ITEM, "a", { rank: 5 })).toEqual({ id: "a", rank: 5 })
		expect(await store.byId(ITEM, "a")).toEqual({ id: "a", rank: 5 })
		expect(await store.update(ITEM, "zz", { rank: 5 })).toBeNull()
	})

	it("removes a row, and forgets everything on close", async () => {
		const store = await seeded()
		await store.remove(ITEM, "a")
		expect(ids(await store.select(ITEM, ALL))).toEqual(["b", "c"])
		await store.close()
		expect(await store.select(ITEM, ALL)).toEqual([])
	})

	it("selects the matching rows in the plan's order", async () => {
		const store = await seeded()
		const plan: SelectPlan = {
			...ALL,
			order: [{ asText: false, descending: false, field: "rank", nullsFirst: false }],
			where: { asText: false, field: "id", kind: "cmp", nullsMatch: false, op: "neq", value: "c" },
		}
		expect(ids(await store.select(ITEM, plan))).toEqual(["b", "a"])
	})

	it("returns tied rows in a varying order when ties are shuffled", async () => {
		const store = await seeded()
		const shuffled = { ...ALL, shuffleTies: true }
		expect(ids(await store.select(ITEM, shuffled))).toEqual(["b", "c", "a"])
		expect(ids(await store.select(ITEM, shuffled))).toEqual(["c", "a", "b"])
		expect(ids(await store.select(ITEM, ALL))).toEqual(["a", "b", "c"])
		await store.remove(ITEM, "a")
		await store.remove(ITEM, "b")
		expect(ids(await store.select(ITEM, shuffled))).toEqual(["c"])
	})
})
