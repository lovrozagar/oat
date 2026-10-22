import { describe, expect, it, vi } from "vitest"
import { ALPHA, api, BETA, JOBS, MEMBER, rowsOf, TABLES, VIEWER } from "../__fixtures__/api.ts"

/* A world with one of alpha's tables in it, and that table's path. */
async function withTable(options = {}) {
	const world = await api(options)
	const made = await world.table("t")
	await world.call("PATCH", `${TABLES}/${String(made.id)}`, { body: { description: "d", position: 2 } })
	return { ...world, item: `${TABLES}/${String(made.id)}`, made }
}

describe("reading a record", () => {
	it("answers the record to each of its tenant's roles, and 404 to another tenant", async () => {
		const { call, item } = await withTable()
		for (const token of [ALPHA, MEMBER, VIEWER]) {
			expect((await call("GET", item, { token })).body).toMatchObject({ description: "d", name: "t" })
		}
		expect((await call("GET", item, { token: BETA })).status).toBe(404)
		expect((await call("GET", `${TABLES}/missing`)).status).toBe(404)
	})

	it("refuses the member alone under ROLE_MONOTONICITY_BROKEN", async () => {
		const { call, item } = await withTable({ defects: ["ROLE_MONOTONICITY_BROKEN"] })
		expect((await call("GET", item, { token: MEMBER })).status).toBe(403)
		expect((await call("GET", item, { token: VIEWER })).status).toBe(200)
	})

	it("drops a table's description under READ_DROPS_FIELD", async () => {
		const { call, item } = await withTable({ defects: ["READ_DROPS_FIELD"] })
		expect((await call("GET", item)).body).not.toHaveProperty("description")
		const job = (await call("POST", JOBS, { body: { name: "j", note: "n" } })).body
		expect((await call("GET", `${JOBS}/${String(job.id)}`)).body).toMatchObject({ note: "n" })
	})

	it("wraps the record beside its fields under recordEnvelope", async () => {
		const { call } = await api({ shape: "wrapped-records" })
		const { body } = await call("GET", `${TABLES}/1`)
		expect(body).toMatchObject({ data: { ID: 1, Status: { ID: 1, Name: "open" } }, fields: expect.any(Array) })
	})
})

describe("updating a record", () => {
	it("writes only the named fields", async () => {
		const { call, item } = await withTable()
		const { status, body } = await call("PATCH", item, { body: { name: "renamed" } })
		expect(status).toBe(200)
		expect(body).toMatchObject({ description: "d", name: "renamed", position: 2 })
	})

	it("refuses a viewer, a body that is not JSON, another tenant, an invalid body and a taken name", async () => {
		const { call, item, table } = await withTable()
		await table("taken")
		expect((await call("PATCH", item, { body: { name: "v" }, token: VIEWER })).status).toBe(403)
		expect((await call("PATCH", item, { form: "name=f" })).status).toBe(415)
		expect((await call("PATCH", item, { body: { name: "x" }, token: BETA })).status).toBe(403)
		expect((await call("PATCH", item, { body: { project_id: "proj_beta" } })).status).toBe(400)
		expect((await call("PATCH", item, { body: { name: "taken" } })).status).toBe(409)
		expect((await call("PATCH", item, { body: { name: "t" } })).status).toBe(200)
	})

	it("replaces the writable fields under PUT, and refuses PATCH there", async () => {
		const { call, item } = await withTable({ shape: "put-update" })
		expect((await call("PATCH", item, { body: { name: "p" } })).status).toBe(405)
		expect((await call("PUT", item, { body: { name: "p" } })).body).toMatchObject({
			description: null,
			name: "p",
			position: 0,
		})
		expect((await call("PUT", item, { body: {} })).status).toBe(400)
	})

	it("resets what the patch leaves out under PATCH_REPLACES, keeping the identity and parents", async () => {
		const { call, item, made } = await withTable({ defects: ["PATCH_REPLACES"] })
		expect((await call("PATCH", item, { body: { name: "r" } })).body).toMatchObject({
			description: null,
			id: made.id,
			name: "r",
			position: 0,
			project_id: "proj_alpha",
		})
	})

	it("answers 201 under RESPONSE_STATUS_UNDECLARED, and moves a record under IMMUTABLE_WRITABLE", async () => {
		const { call, item } = await withTable({ defects: ["RESPONSE_STATUS_UNDECLARED", "IMMUTABLE_WRITABLE"] })
		const moved = await call("PATCH", item, { body: { project_id: "proj_beta" } })
		expect(moved).toMatchObject({ body: { project_id: "proj_beta" }, status: 201 })
	})

	it("writes another tenant's record under CROSS_TENANT_WRITE", async () => {
		const { call, table } = await api({ defects: ["CROSS_TENANT_WRITE"] })
		const theirs = await table("theirs", BETA)
		const path = `${TABLES}/${String(theirs.id)}`
		expect((await call("PATCH", path, { body: { name: "mine" } })).body).toMatchObject({ name: "mine" })
	})
})

describe("an update under WRITE_BODY_NOT_VALIDATED", () => {
	it("applies what parses of a table's or a row's update and drops the rest; a job's update still refuses", async () => {
		const { call, item, made } = await withTable({ defects: ["WRITE_BODY_NOT_VALIDATED"] })
		const table = await call("PATCH", item, { body: { description: "kept", name: 7 } })
		expect(table).toMatchObject({ body: { description: "kept", name: "t" }, status: 200 })
		const rows = rowsOf(made.id)
		const row = (await call("POST", rows, { body: { amount: 3, label: "r" } })).body
		const patched = await call("PATCH", `${rows}/${String(row.id)}`, { body: { amount: "many", label: "s" } })
		expect(patched).toMatchObject({ body: { amount: 3, label: "s" }, status: 200 })
		const job = (await call("POST", JOBS, { body: { name: "j" } })).body
		expect((await call("PATCH", `${JOBS}/${String(job.id)}`, { body: { name: 7 } })).status).toBe(400)
	})

	it("still refuses a field no writer may send, and validates nothing it was not asked to skip", async () => {
		const { call, item } = await withTable({ defects: ["WRITE_BODY_NOT_VALIDATED"] })
		expect((await call("PATCH", item, { body: { project_id: "proj_beta" } })).status).toBe(400)
		expect((await call("PATCH", item, { body: { unknown: 1 } })).status).toBe(400)
		expect((await call("POST", TABLES, { body: { name: 7 } })).status).toBe(400)
	})

	it("refuses the same invalid update on a correct backend", async () => {
		const { call, item } = await withTable()
		expect((await call("PATCH", item, { body: { description: "kept", name: 7 } })).status).toBe(400)
	})
})

describe("an update without a lock", () => {
	it("writes back the whole record it read under CONCURRENT_WRITE_LOST", async () => {
		const { call, item } = await withTable({ defects: ["CONCURRENT_WRITE_LOST"] })
		const [first, second] = await Promise.all([
			call("PATCH", item, { body: { name: "first" } }),
			call("PATCH", item, { body: { position: 9 } }),
		])
		expect([first.status, second.status]).toEqual([200, 200])
		expect((await call("GET", item)).body).toMatchObject({ name: "t", position: 9 })
	})

	it("answers the record as read when it is gone before the write lands", async () => {
		const { call } = await api({ defects: ["CONCURRENT_WRITE_LOST"] })
		await call("POST", JOBS, { body: { name: "j" } })
		const pending = call("PATCH", `${JOBS}/job_000001`, { body: { note: "n" } })
		expect((await call("DELETE", `${JOBS}/job_000001`)).status).toBe(200)
		expect((await pending).body).toMatchObject({ name: "j", note: "n" })
	})
})

describe("a version precondition on an update", () => {
	it("tags a read with a strong ETag that holds still between writes and moves on each one", async () => {
		const { call, item } = await withTable()
		const first = (await call("GET", item)).headers.etag
		expect(first).toMatch(/^"[\w-]+"$/)
		expect((await call("GET", item)).headers.etag).toBe(first)
		await call("PATCH", item, { body: { description: "d" } })
		expect((await call("GET", item)).headers.etag).not.toBe(first)
	})

	it("applies an update naming the current ETag or *, and refuses a stale one with a 412 problem detail", async () => {
		const { call, item } = await withTable()
		const stale = (await call("GET", item)).headers.etag ?? ""
		expect((await call("PATCH", item, { body: { name: "a" }, headers: { "if-match": stale } })).status).toBe(200)
		const refused = await call("PATCH", item, { body: { name: "b" }, headers: { "if-match": stale } })
		expect(refused.status).toBe(412)
		expect(refused.headers["content-type"]).toBe("application/problem+json")
		expect(refused.body).toMatchObject({ status: 412, title: "Precondition Failed", type: "about:blank" })
		expect((await call("GET", item)).body).toMatchObject({ name: "a" })
		const current = (await call("GET", item)).headers.etag ?? ""
		const listed = `"other", ${current}`
		expect((await call("PATCH", item, { body: { name: "c" }, headers: { "if-match": listed } })).status).toBe(200)
		expect((await call("PATCH", item, { body: { name: "d" }, headers: { "if-match": "*" } })).status).toBe(200)
	})

	it("leaves the 412 a problem detail under ERROR_SCHEMA_DRIFT", async () => {
		const { call, item } = await withTable({ defects: ["ERROR_SCHEMA_DRIFT"] })
		const refused = await call("PATCH", item, { body: { name: "b" }, headers: { "if-match": '"stale"' } })
		expect([refused.status, refused.body.status]).toEqual([412, 412])
	})

	it("applies a stale update under ETAG_IGNORED, and misstates the 412 under PROBLEM_JSON_MALFORMED", async () => {
		const ignored = await withTable({ defects: ["ETAG_IGNORED"] })
		const sent = { body: { name: "b" }, headers: { "if-match": '"stale"' } }
		expect((await ignored.call("PATCH", ignored.item, sent)).status).toBe(200)
		const malformed = await withTable({ defects: ["PROBLEM_JSON_MALFORMED"] })
		const refused = await malformed.call("PATCH", malformed.item, sent)
		expect([refused.status, refused.body.status]).toEqual([412, 400])
	})
})

describe("the slug of a table", () => {
	it("is not changed by an update", async () => {
		const { call } = await api({ defects: ["PATCH_REPLACES"], shape: "tenant-slugs" })
		const made = (await call("POST", TABLES, { body: { name: "First Name" } })).body
		const updated = await call("PATCH", `${TABLES}/first-name`, { body: { name: "Second" } })
		expect(updated.body).toMatchObject({ name: "Second", slug: "first-name" })
		const row = await call("POST", rowsOf("first-name"), { body: { label: "r" } })
		expect(row.body.table_id).toBe(made.id)
		expect((await call("PATCH", `${rowsOf("first-name")}/${String(row.body.id)}`, { body: {} })).status).toBe(200)
	})
})

/* Two of one entity's updates, the second made first, maybe with another entity's write between. */
async function updatedOrder(between: boolean): Promise<unknown[]> {
	const { call, table } = await api()
	const [first, second] = [await table("first"), await table("second")]
	await call("PATCH", `${TABLES}/${String(second.id)}`, { body: { description: "x" } })
	if (between) await call("POST", JOBS, { body: { name: "j" } })
	await call("PATCH", `${TABLES}/${String(first.id)}`, { body: { description: "y" } })
	const listed = (await call("GET", `${TABLES}?order=updated_at.asc&limit=100`)).body.tables as Array<{
		name: string
	}>
	return listed.map((record) => record.name).filter((name) => name === "first" || name === "second")
}

describe("ordering by when a record was written", () => {
	it("lists updates in the order they were made, whether or not another entity wrote between them", async () => {
		expect(await updatedOrder(false)).toEqual(["second", "first"])
		expect(await updatedOrder(true)).toEqual(["second", "first"])
	})
})

describe("deleting a record", () => {
	it("soft-deletes a table: it reads as gone and stays stored", async () => {
		const { call, item, state, made } = await withTable()
		const written = (await call("GET", item)).body.updated_at
		const { status, body } = await call("DELETE", item)
		expect(status).toBe(200)
		/* A delete is a write of its own: stamped after the last one. */
		expect(body.deleted_at).toBeGreaterThan(Number(written))
		expect(body.updated_at).toBe(body.deleted_at)
		expect((await call("GET", item)).status).toBe(404)
		expect(await state.store.byId(state.table, String(made.id))).not.toBeNull()
	})

	it("removes a row outright and refreshes its table's count", async () => {
		const { call, item } = await withTable()
		const rows = `${item}/rows`
		const row = (await call("POST", rows, { body: { label: "r" } })).body
		expect((await call("DELETE", `${rows}/${String(row.id)}`)).body).toMatchObject({ label: "r" })
		expect((await call("GET", `${rows}/${String(row.id)}`)).status).toBe(404)
		expect((await call("GET", item)).body.row_count).toBe(0)
	})

	it("refuses a member, a viewer, a missing record and another tenant's", async () => {
		const { call, item, table } = await withTable()
		const theirs = await table("theirs", BETA)
		expect((await call("DELETE", item, { token: MEMBER })).status).toBe(403)
		expect((await call("DELETE", item, { token: VIEWER })).status).toBe(403)
		expect((await call("DELETE", `${TABLES}/missing`)).body.message).toBe("table missing does not exist")
		expect((await call("DELETE", `${TABLES}/${String(theirs.id)}`)).status).toBe(404)
	})

	it("answers 200 for a missing record under DELETE_MISSING_OK, and keeps the row under DELETE_KEEPS_ROW", async () => {
		const { call } = await api({ defects: ["DELETE_MISSING_OK", "DELETE_KEEPS_ROW"] })
		expect((await call("DELETE", `${JOBS}/missing`)).body).toEqual({ id: "missing" })
		await call("POST", JOBS, { body: { name: "j" } })
		expect((await call("DELETE", `${JOBS}/job_000001`)).status).toBe(200)
		expect((await call("GET", `${JOBS}/job_000001`)).status).toBe(200)
	})

	it("answers that it removed a hidden row it keeps under HIDDEN_FROM_CREATOR", async () => {
		const { call, item, state } = await withTable({ defects: ["HIDDEN_FROM_CREATOR"] })
		const rows = `${item}/rows`
		const probe = (await call("POST", rows, { body: { label: "oat-payload-probe" } })).body
		expect((await call("DELETE", `${rows}/${String(probe.id)}`)).status).toBe(200)
		expect(await state.store.byId(state.entities[1] as never, String(probe.id))).not.toBeNull()
	})

	it("answers what it found when the tombstone lands on nothing, and wraps the answer under recordEnvelope", async () => {
		const { call, state, item } = await withTable()
		vi.spyOn(state.store, "update").mockResolvedValueOnce(null)
		expect((await call("DELETE", item)).body).toMatchObject({ deleted_at: null, name: "t" })
		const wrapped = await api({ shape: "wrapped-records" })
		expect((await wrapped.call("DELETE", `${TABLES}/1`)).body).toEqual({ id: 1, message: "deleted", success: true })
	})
})
