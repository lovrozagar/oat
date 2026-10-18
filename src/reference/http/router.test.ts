import { describe, expect, it, vi } from "vitest"
import { api, JOBS, TABLES } from "./__fixtures__/api.ts"

describe("handle", () => {
	it("answers a path no route serves with a 404", async () => {
		const { call } = await api()
		expect(await call("GET", "/v1/widgets")).toMatchObject({
			body: { error_key: "not_found", message: "no route for /v1/widgets" },
			status: 404,
		})
	})

	it("answers a method a collection lacks with a 404, and one an item lacks with a 405", async () => {
		const { call, table } = await api()
		const made = await table("t")
		expect((await call("PUT", TABLES)).body.message).toBe("method PUT not supported here")
		expect(await call("POST", `${TABLES}/${String(made.id)}`)).toMatchObject({
			body: { error_key: "method_not_allowed" },
			status: 405,
		})
	})

	it("authenticates every entity route, and binds collections and writes to the caller's tenant", async () => {
		const { call, table } = await api()
		const made = await table("t")
		expect((await call("GET", TABLES, { token: null })).status).toBe(401)
		expect((await call("GET", "/v1/projects/proj_beta/tables")).status).toBe(403)
		expect((await call("GET", `${TABLES}/missing/rows`)).status).toBe(404)
		expect((await call("GET", `/v1/projects/proj_beta/tables/${String(made.id)}`)).status).toBe(404)
	})

	it("advances started jobs before a job is read", async () => {
		const { call } = await api()
		const now = vi.spyOn(Date, "now").mockReturnValue(0)
		await call("POST", `${JOBS}/start`, { body: { name: "j" } })
		now.mockReturnValue(1000)
		expect((await call("GET", JOBS)).body.jobs).toEqual([
			expect.objectContaining({ progress: 100, status: "complete" }),
		])
		now.mockRestore()
	})

	it("answers an unexpected failure as a 500", async () => {
		const { call, state } = await api()
		vi.spyOn(state.store, "select").mockRejectedValueOnce(new Error("disk on fire"))
		expect(await call("GET", TABLES)).toMatchObject({
			body: { error_key: "internal_error", message: "disk on fire" },
			status: 500,
		})
	})
})

describe("a base path", () => {
	it("serves the API under it, and nothing outside it", async () => {
		const { call } = await api({ shape: "path-prefix" })
		expect((await call("GET", "/api/health")).status).toBe(200)
		expect((await call("POST", `/api${TABLES}`, { body: { name: "t" } })).status).toBe(201)
		expect((await call("GET", "/health")).body.message).toBe("no route for /health")
		expect((await call("GET", "/apihealth")).status).toBe(404)
		expect((await call("GET", "/api")).body.message).toBe("no route for /")
	})
})
