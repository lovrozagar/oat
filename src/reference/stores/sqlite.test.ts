import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import { ENTITIES } from "../model/entities.ts"
import type { EntityDef } from "../model/types.ts"
import type { FilterNode, SelectPlan } from "../query-types.ts"
import { SqlStore } from "./sqlite.ts"
import { nodeSqliteDriver, type SqliteDriver, type SqlRow, type SqlValue } from "./sqlite-driver.ts"

const ITEM: EntityDef = {
	collectionPath: "/items",
	defaultLimit: 10,
	defaultOrder: "id.asc",
	fields: [
		{ name: "id", required: true, type: "string" },
		{ name: "name", type: "string" },
		{ name: "count", type: "integer" },
		{ name: "active", type: "boolean" },
		{ name: "meta", type: "object" },
		{ name: "tags", type: "array" },
	],
	identity: "id",
	itemParam: "item_id",
	itemPath: "/items/{item_id}",
	maxLimit: 100,
	name: "item",
	parents: [],
	plural: "items",
}

interface Call {
	kind: "all" | "close" | "exec" | "run"
	sql?: string
	args?: SqlValue[]
}

/* A driver that records every call, answers `all` from `rows`, and fails what `fails` names. */
function recordingDriver(options: { dqs?: boolean; rows?: SqlRow[]; fails?: (sql: string) => boolean } = {}) {
	const calls: Call[] = []
	const fail = (sql: string): void => {
		if (options.fails?.(sql) === true) throw new Error(`refused: ${sql}`)
	}
	const driver: SqliteDriver = {
		all: async (sql, args) => {
			calls.push({ args, kind: "all", sql })
			return options.rows ?? []
		},
		close: async () => {
			calls.push({ kind: "close" })
		},
		dqs: options.dqs ?? false,
		engine: "recording",
		exec: async (sql) => {
			calls.push({ kind: "exec", sql })
			fail(sql)
		},
		run: async (sql, args) => {
			calls.push({ args, kind: "run", sql })
		},
	}
	return { calls, driver }
}

async function sqlite(defects: DefectName[] = []): Promise<SqlStore> {
	return SqlStore.create(new DefectSet(defects), await nodeSqliteDriver(), { entities: [ITEM] })
}

const plan = (where: FilterNode, order: SelectPlan["order"] = []): SelectPlan => ({
	collation: "binary",
	order,
	shuffleTies: false,
	where,
})

const ROWS = [
	{ active: true, count: 2, id: "a", meta: { k: 1 }, name: "Apple", tags: ["red", "green"] },
	{ active: false, count: 10, id: "b", name: "apricot", tags: ["redwood"] },
	{ id: "c" },
]

async function seeded(): Promise<SqlStore> {
	const store = await sqlite()
	for (const row of ROWS) await store.insert(ITEM, row)
	return store
}

const ids = (rows: Array<Record<string, unknown>>): unknown[] => rows.map((row) => row["id"])

/* The predicates and orders the engine tests select by. */
const like = (insensitive: boolean): FilterNode => ({
	field: "name",
	insensitive,
	kind: "like",
	pattern: [{ kind: "text", text: "ap" }, { kind: "any" }],
})
const contains = (substring: boolean): FilterNode => ({ field: "tags", kind: "contains", substring, value: "red" })
const search = (caseSensitive: boolean): FilterNode => ({
	caseSensitive,
	fields: ["name"],
	kind: "search",
	mode: "prefix",
	token: "A",
})
const active = (value: boolean): FilterNode => ({
	asText: false,
	field: "active",
	kind: "cmp",
	nullsMatch: false,
	op: "eq",
	value,
})
const by = (field: string): SelectPlan["order"] => [{ asText: false, descending: false, field, nullsFirst: false }]

describe("SqlStore.create", () => {
	it("writes the whole schema as one script, a table and an id index per entity", async () => {
		const { calls, driver } = recordingDriver()
		await SqlStore.create(new DefectSet(), driver, { entities: [ITEM], prefix: "run_" })
		expect(calls).toEqual([
			{
				kind: "exec",
				sql:
					'CREATE TABLE "run_items" (\n  "id" TEXT NOT NULL,\n  "name" TEXT,\n  "count" INTEGER,\n  "active" INTEGER,\n' +
					'  "meta" TEXT,\n  "tags" TEXT\n);\nCREATE INDEX "run_idx_items_id" ON "run_items" ("id")',
			},
		])
	})

	it("defaults to no prefix and every reference entity", async () => {
		const { calls, driver } = recordingDriver()
		await SqlStore.create(new DefectSet(), driver)
		expect(calls[0]?.sql?.match(/CREATE TABLE "[a-z_]+"/g)).toEqual(
			ENTITIES.map((entity) => `CREATE TABLE "${entity.plural}"`),
		)
	})
})

describe("SqlStore on node:sqlite", () => {
	it("stores rows and reads them back in their declared shapes", async () => {
		const store = await seeded()
		expect(await store.byId(ITEM, "a")).toEqual(ROWS[0])
		expect(await store.byId(ITEM, "c")).toEqual({
			active: null,
			count: null,
			id: "c",
			meta: null,
			name: null,
			tags: null,
		})
		expect(await store.byId(ITEM, "zz")).toBeNull()
		await store.close()
	})

	it("updates the known fields and answers the row, or null for no row", async () => {
		const store = await seeded()
		expect(await store.update(ITEM, "a", { active: false, bogus: 1, meta: null })).toMatchObject({
			active: false,
			meta: null,
		})
		expect(await store.update(ITEM, "a", { bogus: 1 })).toMatchObject({ id: "a", name: "Apple" })
		expect(await store.update(ITEM, "zz", { name: "x" })).toBeNull()
		await store.remove(ITEM, "a")
		expect(await store.byId(ITEM, "a")).toBeNull()
		await store.close()
	})
})

describe("SqlStore queries on node:sqlite", () => {
	it("matches patterns with GLOB, folding case only when asked", async () => {
		const store = await seeded()
		expect(ids(await store.select(ITEM, plan(like(false))))).toEqual(["b"])
		expect(ids(await store.select(ITEM, plan(like(true))))).toEqual(["a", "b"])
		await store.close()
	})

	it("tests array membership, and the serialised array as text under the defect", async () => {
		const store = await seeded()
		expect(ids(await store.select(ITEM, plan(contains(false))))).toEqual(["a"])
		expect(ids(await store.select(ITEM, plan(contains(true))))).toEqual(["a", "b"])
		await store.close()
	})

	it("searches by position, case-sensitive or not, and compares booleans as stored", async () => {
		const store = await seeded()
		expect(ids(await store.select(ITEM, plan(search(true))))).toEqual(["a"])
		expect(ids(await store.select(ITEM, plan(search(false))))).toEqual(["a", "b"])
		expect(ids(await store.select(ITEM, plan(active(false))))).toEqual(["b"])
		expect(ids(await store.select(ITEM, plan(active(true))))).toEqual(["a"])
		await store.close()
	})

	it("orders by the plan, numbers by value and text binary", async () => {
		const store = await seeded()
		const all: FilterNode = { kind: "const", value: true }
		expect(ids(await store.select(ITEM, plan(all, by("count"))))).toEqual(["a", "b", "c"])
		expect(ids(await store.select(ITEM, plan(all, by("name"))))).toEqual(["a", "b", "c"])
		expect(await store.select(ITEM, { ...plan(all), shuffleTies: true })).toHaveLength(3)
		await store.close()
	})
})

describe("COLUMN_NAME_MISMATCH", () => {
	const named: EntityDef = {
		...ITEM,
		fields: [
			{ name: "id", type: "string" },
			{ name: "name", type: "string" },
		],
	}

	it("serves the column's own name where the engine refuses the read", async () => {
		const store = await SqlStore.create(new DefectSet(["COLUMN_NAME_MISMATCH"]), await nodeSqliteDriver(), {
			entities: [named],
		})
		expect(await store.insert(named, { id: "a", name: "real" })).toEqual({ id: "a", name: "name" })
		await store.close()
	})

	it("names the column in its natural form on an engine with the double-quoted-string fallback", async () => {
		const { calls, driver } = recordingDriver({ dqs: true })
		const store = await SqlStore.create(new DefectSet(["COLUMN_NAME_MISMATCH"]), driver, { entities: [named] })
		expect(calls[0]?.sql).toContain('"mislabelled_name" TEXT')
		expect(await store.insert(named, { id: "a", name: "real" })).toEqual({ id: "a", name: "real" })
		expect(calls[1]).toEqual({
			args: ["a", "real"],
			kind: "all",
			sql: 'INSERT INTO "items" ("id", "mislabelled_name") VALUES (?, ?) RETURNING "id", "name"',
		})
	})
})

describe("SqlStore.close", () => {
	it("drops this run's tables on a shared engine, past a drop that fails, then closes", async () => {
		const other: EntityDef = { ...ITEM, plural: "others" }
		const { calls, driver } = recordingDriver({ fails: (sql) => sql === 'DROP TABLE IF EXISTS "run_items"' })
		const store = await SqlStore.create(new DefectSet(), driver, { entities: [ITEM, other], prefix: "run_" })
		await store.close()
		expect(calls.slice(1)).toEqual([
			{ kind: "exec", sql: 'DROP TABLE IF EXISTS "run_items"' },
			{ kind: "exec", sql: 'DROP TABLE IF EXISTS "run_others"' },
			{ kind: "close" },
		])
	})

	it("only closes an unprefixed engine", async () => {
		const { calls, driver } = recordingDriver()
		await (await SqlStore.create(new DefectSet(), driver, { entities: [ITEM] })).close()
		expect(calls.slice(1)).toEqual([{ kind: "close" }])
	})
})
