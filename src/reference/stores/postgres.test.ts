import { describe, expect, it, vi } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import { ENTITIES } from "../model/entities.ts"
import type { EntityDef } from "../model/types.ts"
import type { SelectPlan } from "../query-types.ts"
import type { Row } from "../store-api.ts"
import { fakePostgres, type Statement } from "./__fixtures__/postgres.ts"
import { connectPostgres, PgStore } from "./postgres.ts"

const ITEM: EntityDef = {
	collectionPath: "/items",
	defaultLimit: 10,
	defaultOrder: "id.asc",
	fields: [
		{ name: "id", required: true, type: "string" },
		{ name: "name", type: "string" },
		{ name: "count", type: "integer" },
		{ name: "price", type: "number" },
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

const SELECT = `SELECT "id" AS "id", "name" AS "name", "count" AS "count", "price" AS "price", "active" AS "active", "meta" AS "meta", "tags" AS "tags" FROM "items"`

async function store(answer?: (statement: Statement) => Row[], defects: DefectName[] = []) {
	const pg = fakePostgres(answer)
	const created = await PgStore.create(new DefectSet(defects), [ITEM], pg.connect)
	return { pg, store: created }
}

/* Statements after the store's own setup: the database and its tables. */
function since(statements: Statement[]): Statement[] {
	return statements.slice(2)
}

describe("PgStore.create", () => {
	it("makes a scratch database from the admin session, then a typed table per entity in it", async () => {
		const { pg } = await store()
		const [made, table] = pg.statements
		expect(made?.database).toBe("postgres")
		expect(made?.query).toMatch(/^CREATE DATABASE "oat_ref_\d+_[a-z0-9]+"$/)
		expect(table).toEqual({
			database: made?.query.slice('CREATE DATABASE "'.length, -1),
			query:
				'CREATE TABLE "items" ("id" text NOT NULL, "name" text, "count" bigint, "price" double precision, "active" boolean, "meta" text, "tags" text, PRIMARY KEY ("id"))',
		})
	})

	it("migrates every reference entity when given none", async () => {
		const pg = fakePostgres()
		await PgStore.create(new DefectSet(), undefined, pg.connect)
		expect(pg.statements.filter((statement) => statement.query.startsWith("CREATE TABLE"))).toHaveLength(
			ENTITIES.length,
		)
	})

	it("names the column otherwise in DDL, and reads a literal back, under COLUMN_NAME_MISMATCH", async () => {
		const { pg, store: created } = await store(() => [], ["COLUMN_NAME_MISMATCH"])
		expect(pg.statements[1]?.query).toContain('"mislabeled_name" text')
		await created.remove(ITEM, "a")
		await created.byId(ITEM, "a")
		expect(since(pg.statements).map((statement) => statement.query)).toEqual([
			'DELETE FROM "items" WHERE "id" = $1',
			`SELECT "id" AS "id", 'name'::text AS "name", "count" AS "count", "price" AS "price", "active" AS "active", "meta" AS "meta", "tags" AS "tags" FROM "items" WHERE "id" = $1`,
		])
	})
})

describe("PgStore writes", () => {
	it("inserts the set fields, objects as JSON, and reads the stored row back", async () => {
		const stored = { active: true, count: "3", id: "a", meta: '{"k":1}', name: "n", price: 1.5, tags: null }
		const { pg, store: created } = await store(({ query }) => (query.startsWith("SELECT") ? [stored] : []))
		const row = await created.insert(ITEM, { count: 3, id: "a", meta: { k: 1 }, name: "n", price: undefined })
		expect(since(pg.statements)).toEqual([
			{
				args: ["a", "n", 3, '{"k":1}'],
				database: expect.any(String),
				query: 'INSERT INTO "items" ("id", "name", "count", "meta") VALUES ($1, $2, $3, $4)',
			},
			{ args: ["a"], database: expect.any(String), query: `${SELECT} WHERE "id" = $1` },
		])
		expect(row).toEqual({ active: true, count: 3, id: "a", meta: { k: 1 }, name: "n", price: 1.5, tags: null })
	})

	it("answers the record it was given when the read back finds nothing", async () => {
		const { store: created } = await store()
		expect(await created.insert(ITEM, { id: "a" })).toEqual({ id: "a" })
		expect(await created.byId(ITEM, "a")).toBeNull()
	})

	it("decodes each declared type, and an absent column as null", async () => {
		const raw = { active: false, count: "9007", id: "a", meta: { already: "parsed" }, price: "2.5", tags: "[1]" }
		const { store: created } = await store(() => [raw])
		expect(await created.byId(ITEM, "a")).toEqual({
			active: false,
			count: 9007,
			id: "a",
			meta: { already: "parsed" },
			name: null,
			price: 2.5,
			tags: [1],
		})
	})

	it("updates the known fields, clearing one set to undefined, then reads the row", async () => {
		const { pg, store: created } = await store()
		await created.update(ITEM, "a", { bogus: 1, name: undefined, tags: ["x"] })
		expect(since(pg.statements).map(({ args, query }) => ({ args, query }))).toEqual([
			{ args: [null, '["x"]', "a"], query: 'UPDATE "items" SET "name" = $1, "tags" = $2 WHERE "id" = $3' },
			{ args: ["a"], query: `${SELECT} WHERE "id" = $1` },
		])
	})

	it("only reads the row when the patch names no field", async () => {
		const { pg, store: created } = await store()
		await created.update(ITEM, 7, { bogus: 1 })
		expect(since(pg.statements).map(({ args, query }) => ({ args, query }))).toEqual([
			{ args: [7], query: `${SELECT} WHERE "id" = $1` },
		])
	})
})

const plan = (where: SelectPlan["where"], order: SelectPlan["order"] = []): SelectPlan => ({
	collation: "binary",
	order,
	shuffleTies: false,
	where,
})

async function selected(selectPlan: SelectPlan): Promise<Statement | undefined> {
	const { pg, store: created } = await store(() => [{ id: "a" }])
	expect(await created.select(ITEM, selectPlan)).toEqual([
		{ active: null, count: null, id: "a", meta: null, name: null, price: null, tags: null },
	])
	return since(pg.statements)[0]
}

describe("PgStore.select", () => {
	it("compiles the predicate with numbered placeholders and Postgres's own spellings", async () => {
		const where: SelectPlan["where"] = {
			children: [
				{ asText: false, field: "name", kind: "cmp", nullsMatch: false, op: "eq", value: "n" },
				{ asText: false, field: "active", kind: "cmp", nullsMatch: false, op: "eq", value: true },
				{ field: "name", insensitive: false, kind: "like", pattern: [{ kind: "text", text: "a%" }, { kind: "any" }] },
				{ field: "name", insensitive: true, kind: "like", pattern: [{ kind: "one" }] },
				{ field: "tags", kind: "contains", substring: false, value: "red" },
				{ field: "tags", kind: "contains", substring: true, value: "red" },
				{ caseSensitive: false, fields: ["name"], kind: "search", mode: "prefix", token: "q" },
				{ asText: true, field: "count", kind: "in", negate: false, values: [1] },
			],
			kind: "and",
		}
		const statement = await selected(plan(where))
		expect(statement?.args).toEqual(["n", true, "a\\%%", "_", "red", "red", "q", "1"])
		expect(statement?.query).toBe(
			`${SELECT} WHERE ("name" COLLATE "C" = $1 AND "active" = $2 AND "name" LIKE $3 ESCAPE '\\' AND ` +
				`"name" ILIKE $4 ESCAPE '\\' AND jsonb_exists("tags"::jsonb, $5) AND strpos("tags", $6::text) > 0 AND ` +
				`(strpos(lower("name"::text), lower($7::text)) = 1) AND "count"::text IN ($8))`,
		)
	})

	it("orders with Postgres's random for shuffled ties", async () => {
		const order = [{ asText: false, descending: true, field: "count", nullsFirst: true }]
		const statement = await selected({ ...plan({ kind: "const", value: true }, order), shuffleTies: true })
		expect(statement?.query).toBe(`${SELECT} WHERE 1 = 1 ORDER BY "count" IS NULL DESC, "count" DESC, random()`)
	})
})

describe("PgStore.close", () => {
	it("ends its sessions and drops its scratch database", async () => {
		const { pg, store: created } = await store()
		await created.close()
		const database = pg.statements[1]?.database as string
		expect(since(pg.statements)).toEqual([
			{ database: "postgres", query: `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)` },
		])
		expect(pg.ended).toEqual([
			{ database, timeout: 5 },
			{ database: "postgres", timeout: 5 },
		])
	})

	it("still ends the admin session when the drop fails", async () => {
		const { pg, store: created } = await store(({ query }) => {
			if (query.startsWith("DROP")) throw new Error("drop refused")
			return []
		})
		await expect(created.close()).rejects.toThrow("drop refused")
		expect(pg.ended.map(({ database }) => database)).toEqual([expect.any(String), "postgres"])
	})
})

describe("connectPostgres", () => {
	it("opens a lazy postgres.js pool on the named database, its notices silenced", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const sql = connectPostgres("oat_probe", 3)
		expect(sql.options).toMatchObject({ database: "oat_probe", max: 3 })
		sql.options.onnotice({ message: "relation already exists" } as never)
		expect(log).not.toHaveBeenCalled()
		await sql.end({ timeout: 0 })
		log.mockRestore()
	})
})
