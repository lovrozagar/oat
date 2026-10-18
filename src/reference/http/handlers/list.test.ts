import { describe, expect, it } from "vitest"
import type { EntityDef } from "../../model.ts"
import { api, rowsOf, TABLES } from "../__fixtures__/api.ts"

describe("a listing", () => {
	it("answers the tenant's records in the dialect's envelope", async () => {
		const { call, table } = await api()
		await table("a")
		await table("b")
		await call("POST", "/v1/projects/proj_beta/tables", { body: { name: "theirs" }, token: "tok_beta" })
		const { status, body } = await call("GET", `${TABLES}?limit=1`)
		expect(status).toBe(200)
		expect(body).toMatchObject({ count: 2, hasMore: true, limit: 1, page: 1, tables: [{ name: "b" }] })
	})

	it("answers a root array with a next link in the linked dialect", async () => {
		const { call, table } = await api({ dialect: "linked" })
		await table("a")
		await table("b")
		const answer = await call("GET", `${TABLES}?limit=1`)
		expect(answer.items.map((row) => row.name)).toEqual(["b"])
		expect(answer.headers.link).toBe(`<${TABLES}?limit=1&offset=1>; rel="next"`)
	})

	it("refuses its first request under RATE_LIMIT_STRICTER_THAN_DECLARED, per entity", async () => {
		const { call } = await api({ defects: ["RATE_LIMIT_STRICTER_THAN_DECLARED"] })
		const first = await call("GET", TABLES)
		expect(first).toMatchObject({ body: { error: "rate limited" }, headers: { "retry-after": "0" }, status: 429 })
		expect((await call("GET", TABLES)).status).toBe(200)
		expect((await call("GET", "/v1/projects/proj_alpha/jobs")).status).toBe(429)
	})

	it("carries the fields sidecar under recordEnvelope, and not on a root array", async () => {
		const wrapped = await api({ shape: "wrapped-records" })
		const { body } = await wrapped.call("GET", TABLES)
		expect(body).toMatchObject({ data: expect.any(Array), totalCount: 6 })
		expect(body.fields).toContainEqual({ name: "ID", type: "integer" })
		const linked = await api({ dialect: "linked", shape: { recordEnvelope: true } })
		await linked.table("a")
		expect((await linked.call("GET", TABLES)).items).toHaveLength(1)
	})

	it("skews the listed name under LIST_DETAIL_DISAGREE", async () => {
		const { call, table } = await api({ defects: ["LIST_DETAIL_DISAGREE"] })
		await table("a")
		expect((await call("GET", TABLES)).body.tables).toEqual([expect.objectContaining({ name: "a (listing)" })])
	})
})

describe("a stale listing", () => {
	it("replays the collection as it was before the first write, paged as asked", async () => {
		const { call, table } = await api({ defects: ["STALE_LIST"], shape: { prepopulate: 3 } })
		expect((await call("GET", TABLES)).body.count).toBe(3)
		await table("new")
		expect((await call("GET", TABLES)).body).toMatchObject({ count: 3 })
		const page = (await call("GET", `${TABLES}?limit=2&page=2`)).body
		expect(page).toMatchObject({ count: 3, hasMore: false, limit: 2, page: 2 })
		expect(page.tables).toHaveLength(1)
	})

	it("answers a filtered listing live, and sends a bad paging value to be refused", async () => {
		const { call, table } = await api({ defects: ["STALE_LIST"] })
		await table("new")
		expect((await call("GET", TABLES)).body.count).toBe(0)
		expect((await call("GET", `${TABLES}?filter=name.eq.new`)).body.count).toBe(1)
		expect((await call("GET", `${TABLES}?limit=0`)).status).toBe(400)
	})
})

describe("unknown parameters", () => {
	it("empty the listing under UNKNOWN_PARAM_EMPTIES_LIST", async () => {
		const { call, table } = await api({ defects: ["UNKNOWN_PARAM_EMPTIES_LIST"] })
		await table("a")
		expect((await call("GET", `${TABLES}?bogus=1`)).body).toMatchObject({ count: 0, hasMore: false, tables: [] })
		expect((await call("GET", `${TABLES}?limit=5`)).body.count).toBe(1)
	})

	it("do not include a bracketed fieldset or an equality filter field", async () => {
		const jsonapi = await api({ defects: ["UNKNOWN_PARAM_EMPTIES_LIST"], dialect: "jsonapi" })
		await jsonapi.table("a")
		expect((await jsonapi.call("GET", `${TABLES}?fields[table]=id,name`)).body.data).toEqual([
			{ id: "table_000001", name: "a" },
		])
		const plain = await api({ defects: ["UNKNOWN_PARAM_EMPTIES_LIST"], dialect: "plain" })
		await plain.table("a")
		expect((await plain.call("GET", `${TABLES}?status=active`)).body.items).toHaveLength(1)
	})
})

describe("filters in each grammar", () => {
	it("read the canonical, colon, equality and template spellings", async () => {
		const cases = [
			["postgrest", "filter=status.eq.draft"],
			["classic", "filter=status=eq:draft"],
			["plain", "status=draft"],
			["template", "where=and_status_eq_draft"],
		] as const
		for (const [dialect, query] of cases) {
			const { call } = await api({ dialect })
			await call("POST", TABLES, { body: { name: "a", status: "draft" } })
			await call("POST", TABLES, { body: { name: "b" } })
			const { body } = await call("GET", `${TABLES}?${query}`)
			expect(Object.values(body).find(Array.isArray)).toEqual([expect.objectContaining({ name: "a" })])
		}
	})

	it("refuse a malformed filter with a 400, a 500 under ERROR_500_ON_BAD_FILTER, or ignore it", async () => {
		const strict = await api({ dialect: "classic" })
		expect(await strict.call("GET", `${TABLES}?filter=garbage`)).toMatchObject({
			body: { message: "malformed filter: garbage" },
			status: 400,
		})
		const crashing = await api({ defects: ["ERROR_500_ON_BAD_FILTER"], dialect: "classic" })
		expect((await crashing.call("GET", `${TABLES}?filter=garbage`)).status).toBe(500)
		const lax = await api({ defects: ["IGNORES_MALFORMED_FILTER"], dialect: "classic" })
		expect((await lax.call("GET", `${TABLES}?filter=garbage`)).status).toBe(200)
	})
})

describe("sorting", () => {
	it("reads a repeated sort parameter in order", async () => {
		const { call } = await api({ shape: "wrapped-records" })
		const sorted = (await call("GET", `${TABLES}?sort=status_descending&sort=name_ascending`)).body.data as Array<{
			name: string
			status: string
		}>
		const expected = sorted.toSorted((a, b) => b.status.localeCompare(a.status) || (a.name < b.name ? -1 : 1))
		expect(sorted).toEqual(expected)
		expect((await call("GET", TABLES)).status).toBe(200)
	})
})

describe("embedding a related record", () => {
	it("embeds a row's table, and refuses a relation the row does not declare", async () => {
		const { call, table } = await api()
		const parent = await table("parent")
		const rows = rowsOf(parent.id)
		await call("POST", rows, { body: { label: "r" } })
		expect((await call("GET", `${rows}?select=label,table(name)`)).body.rows).toEqual([
			{ label: "r", table: { name: "parent" } },
		])
		expect((await call("GET", `${rows}?select=label,nothing(name)`)).status).toBe(400)
	})

	it("embeds null where the link is missing, not an id, or names no record or entity", async () => {
		const { call, state, table } = await api()
		const parent = await table("parent")
		const rows = rowsOf(parent.id)
		await call("POST", rows, { body: { label: "r" } })
		const row = state.entities.find((entity) => entity.name === "row") as EntityDef
		row.relations = {
			byFlag: { entity: "table", fields: ["name"], via: "active" },
			byLabel: { entity: "table", fields: ["name"], via: "label" },
			ghost: { entity: "ghost", fields: ["name"], via: "table_id" },
		}
		const { body } = await call("GET", `${rows}?select=label,byFlag(name),byLabel(name),ghost(name)`)
		expect(body.rows).toEqual([{ byFlag: null, byLabel: null, ghost: null, label: "r" }])
		const declared = row.relations
		let reads = 0
		Object.defineProperty(row, "relations", { configurable: true, get: () => (reads++ === 0 ? declared : undefined) })
		expect((await call("GET", `${rows}?select=label,byLabel(name)`)).body.rows).toEqual([{ byLabel: null, label: "r" }])
	})
})
