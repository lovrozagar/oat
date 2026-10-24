import { describe, expect, it } from "vitest"
import { api, BETA, JOBS, rowsOf, TABLES, VIEWER } from "../__fixtures__/api.ts"

const KEY = { "idempotency-key": "k1" }

describe("a create", () => {
	it("answers 201 with the stored record, and refreshes the parent's row count", async () => {
		const { call, table } = await api()
		const parent = await table("t")
		expect(parent).toMatchObject({ id: "table_000001", name: "t", project_id: "proj_alpha", row_count: 0 })
		const row = await call("POST", rowsOf(parent["id"]), { body: { label: "r", tags: ["red"] } })
		expect(row).toMatchObject({ body: { label: "r", table_id: parent["id"], tags: ["red"] }, status: 201 })
		expect((await call("GET", `${TABLES}/${String(parent["id"])}`)).body["row_count"]).toBe(1)
	})

	it("refuses a viewer, a body that is not JSON, an invalid body and a taken unique name", async () => {
		const { call, table } = await api()
		await table("taken")
		expect((await call("POST", TABLES, { body: { name: "v" }, token: VIEWER })).status).toBe(403)
		expect((await call("POST", TABLES, { form: "name=f" })).status).toBe(415)
		expect((await call("POST", TABLES, { body: { name: 3 } })).status).toBe(400)
		expect(await call("POST", TABLES, { body: { name: "taken" } })).toMatchObject({
			body: { error_key: "conflict" },
			status: 409,
		})
		expect((await call("POST", "/v1/projects/proj_beta/tables", { body: { name: "x" } })).status).toBe(403)
	})

	it("answers 200 under CREATED_201_AS_200, and drops the description under CREATE_DROPS_FIELD", async () => {
		const { call } = await api({ defects: ["CREATED_201_AS_200", "CREATE_DROPS_FIELD"] })
		const created = await call("POST", TABLES, { body: { description: "d", name: "n" } })
		expect(created.status).toBe(200)
		expect(created.body["description"]).toBeNull()
	})

	it("crashes on non-ASCII text under CREATE_500_ON_NON_ASCII", async () => {
		const { call } = await api({ defects: ["CREATE_500_ON_NON_ASCII"] })
		expect(await call("POST", TABLES, { body: { name: "café" } })).toMatchObject({
			body: { message: "encoding error: could not write row" },
			status: 500,
		})
		expect((await call("POST", TABLES, { body: { name: "cafe", position: 1 } })).status).toBe(201)
	})
})

describe("a create in another shape", () => {
	it("takes a form-encoded body, and only that, under the form-create shape", async () => {
		const { call } = await api({ shape: "form-create" })
		const created = await call("POST", TABLES, { form: "name=f&position=4" })
		expect(created).toMatchObject({ body: { name: "f", position: 4 }, status: 201 })
		expect((await call("POST", TABLES, { body: { name: "j" } })).status).toBe(415)
	})

	it("answers only an acknowledgment for a table under ackCreate", async () => {
		const { call } = await api({ shape: { ackCreate: true } })
		expect((await call("POST", TABLES, { body: { name: "a" } })).body).toEqual({ success: true })
		expect((await call("POST", JOBS, { body: { name: "j" } })).body).toMatchObject({ name: "j" })
	})

	it("answers only { id, message } under ack-create, and a job's receipt as before", async () => {
		const { call } = await api({ shape: "ack-create" })
		const created = await call("POST", TABLES, { body: { name: "a" } })
		expect(created).toMatchObject({ body: { id: "table_000001", message: "created" }, status: 201 })
		expect(Object.keys(created.body)).toEqual(["id", "message"])
		expect((await call("POST", JOBS, { body: { name: "j" } })).body).toMatchObject({ name: "j" })
	})

	it("answers an empty 201 naming the record's absolute URL in Location under location-create", async () => {
		const { call } = await api({ shape: "location-create" })
		const created = await call("POST", TABLES, { body: { name: "l" } })
		expect(created).toMatchObject({ body: null, status: 201 })
		const location = new URL(created.headers["location"] ?? "")
		expect(location.pathname).toBe(`${TABLES}/table_000001`)
		expect((await call("GET", location.pathname)).body).toMatchObject({ id: "table_000001", name: "l" })
		const replay = await call("POST", TABLES, { body: { name: "l" }, headers: KEY })
		const again = await call("POST", TABLES, { body: { name: "l" }, headers: KEY })
		expect(again.headers["location"]).toBe(replay.headers["location"])
		const row = await call("POST", rowsOf("table_000001"), { body: { label: "r" } })
		expect(new URL(row.headers["location"] ?? "").pathname).toMatch(/\/tables\/table_000001\/rows\/[^/]+$/)
	})

	it("wraps the record under recordEnvelope", async () => {
		const { call } = await api({ shape: "wrapped-records" })
		const { body } = await call("POST", TABLES, { body: { name: "w" } })
		expect(body).toMatchObject({ data: { ID: 15, name: "w" }, id: 15, message: "created", success: true })
	})

	it("snapshots the collection once before the first write under STALE_LIST", async () => {
		const { call, state, table } = await api({ defects: ["STALE_LIST"] })
		await table("a")
		await table("b")
		expect(state.staleSnapshot.get("table:proj_alpha:")).toEqual([])
		expect((await call("GET", TABLES)).body["count"]).toBe(0)
	})
})

describe("an idempotent create", () => {
	it("answers a replayed key with the first record, per tenant", async () => {
		const { call } = await api()
		const first = await call("POST", JOBS, { body: { name: "j" }, headers: KEY })
		const again = await call("POST", JOBS, { body: { name: "other" }, headers: KEY })
		expect(again).toEqual(first)
		expect((await call("GET", JOBS)).body["count"]).toBe(1)
		const theirs = await call("POST", "/v1/projects/proj_beta/jobs", { body: { name: "b" }, headers: KEY, token: BETA })
		expect(theirs.body["name"]).toBe("b")
		expect((await call("POST", JOBS, { body: { name: "k" }, headers: { "idempotency-key": "" } })).status).toBe(201)
	})

	it("creates again under IDEMPOTENCY_IGNORED", async () => {
		const { call } = await api({ defects: ["IDEMPOTENCY_IGNORED"] })
		await call("POST", JOBS, { body: { name: "j" }, headers: KEY })
		await call("POST", JOBS, { body: { name: "j" }, headers: KEY })
		expect((await call("GET", JOBS)).body["count"]).toBe(2)
	})

	it("answers the first record and inserts a renamed copy under IDEMPOTENT_REPLAY_INSERTS", async () => {
		const { call } = await api({ defects: ["IDEMPOTENT_REPLAY_INSERTS"] })
		const first = await call("POST", TABLES, { body: { name: "t" }, headers: KEY })
		expect((await call("POST", TABLES, { body: { name: "t" }, headers: KEY })).body).toEqual(first.body)
		const names = ((await call("GET", `${TABLES}?order=name.asc`)).body["tables"] as Array<{ name: string }>).map(
			(row) => row.name,
		)
		expect(names).toEqual(["t", "t-replay"])
		await call("POST", JOBS, { body: { name: "j" }, headers: KEY })
		await call("POST", JOBS, { body: { name: "j" }, headers: KEY })
		expect((await call("GET", JOBS)).body["count"]).toBe(2)
	})

	it("acknowledges a replay under ackCreate, copying a non-text unique column as it was", async () => {
		const { call } = await api({ defects: ["IDEMPOTENT_REPLAY_INSERTS"], shape: "client-ids" })
		const sent = { body: { id: 500, name: "zz" }, headers: KEY }
		expect((await call("POST", TABLES, sent)).body).toEqual({ success: true })
		expect((await call("POST", TABLES, sent)).body).toEqual({ success: true })
		expect((await call("GET", `${TABLES}?filter=name.like.zz*`)).body["count"]).toBe(2)
	})
})

describe("a client-chosen id", () => {
	it("is the table's identity, within the declared range", async () => {
		const { call } = await api({ shape: "client-ids" })
		expect((await call("POST", TABLES, { body: { id: 42, name: "n" } })).status).toBe(201)
		expect((await call("GET", `${TABLES}/42`)).body).toMatchObject({ id: 42, name: "n" })
		for (const id of [0, 1000, 1.5, "7"]) {
			expect((await call("POST", TABLES, { body: { id, name: `bad ${String(id)}` } })).status).toBe(400)
		}
		expect((await call("POST", rowsOf(42), { body: { label: "r" } })).status).toBe(201)
	})

	it("is refused when missing, even where required fields go unchecked", async () => {
		const { call } = await api({ defects: ["REQUIRED_NOT_VALIDATED"], shape: "client-ids" })
		expect(await call("POST", TABLES, { body: { name: "n" } })).toMatchObject({
			body: { message: 'field "id" must be an integer from 1 to 999' },
			status: 400,
		})
	})

	it("refuses a taken id with a 409, in any tenant", async () => {
		const { call } = await api({ shape: "client-ids" })
		await call("POST", TABLES, { body: { id: 42, name: "n" } })
		expect((await call("POST", TABLES, { body: { id: 42, name: "m" } })).status).toBe(409)
		const theirs = { body: { id: 42, name: "b" }, token: BETA }
		expect((await call("POST", "/v1/projects/proj_beta/tables", theirs)).status).toBe(409)
	})

	it("keeps the server's id under CLIENT_ID_IGNORED", async () => {
		const { call } = await api({ defects: ["CLIENT_ID_IGNORED"], shape: "client-ids" })
		await call("POST", TABLES, { body: { id: 42, name: "n" } })
		expect((await call("GET", `${TABLES}/42`)).status).toBe(404)
	})

	it("overwrites the tenant's own record holding the id under CLIENT_ID_OVERWRITES", async () => {
		const { call } = await api({ defects: ["CLIENT_ID_OVERWRITES"], shape: "client-ids" })
		await call("POST", TABLES, { body: { id: 42, name: "n" } })
		expect(await call("POST", TABLES, { body: { id: 42, name: "m" } })).toMatchObject({
			body: { success: true },
			status: 200,
		})
		expect((await call("GET", `${TABLES}/42`)).body["name"]).toBe("m")
		const theirs = { body: { id: 42, name: "b" }, token: BETA }
		expect((await call("POST", "/v1/projects/proj_beta/tables", theirs)).status).toBe(409)
	})
})
