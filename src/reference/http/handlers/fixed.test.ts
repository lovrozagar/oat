import { describe, expect, it } from "vitest"
import { api, BETA } from "../__fixtures__/api.ts"

const operations = (spec: Record<string, unknown>) =>
	Object.values(spec.paths as Record<string, Record<string, Record<string, unknown>>>).flatMap((item) =>
		Object.values(item),
	)

describe("the document route", () => {
	it("serves the tagged document, with no credential needed", async () => {
		const { call } = await api()
		const { status, body } = await call("GET", "/v1/openapi/spec", { token: null })
		expect(status).toBe(200)
		expect(body.openapi).toMatch(/^3\./)
		expect(operations(body).some((operation) => "x-entity" in operation)).toBe(true)
	})

	it("serves the document without oat's tags when untagged", async () => {
		const { call } = await api({ untagged: true })
		const { body } = await call("GET", "/v1/openapi/spec")
		expect(operations(body).some((operation) => "x-entity" in operation)).toBe(false)
	})
})

describe("the token route", () => {
	it("trades a known key for its principal's token", async () => {
		const { call } = await api()
		const { status, body } = await call("POST", "/v1/auth/token", { body: { key: "key_beta" }, token: null })
		expect(status).toBe(200)
		expect(body).toEqual({ access_token: "tok_beta", expires_in: 3600, project_id: "proj_beta" })
	})

	it("refuses an unknown key with a 401, and spells the expiry as a string under TOKEN_EXPIRY_AS_STRING", async () => {
		const { call } = await api({ defects: ["TOKEN_EXPIRY_AS_STRING"] })
		expect((await call("POST", "/v1/auth/token", { body: { key: "nope" } })).status).toBe(401)
		expect((await call("POST", "/v1/auth/token", { body: { key: "key_alpha" } })).body.expires_in).toBe("3600")
		expect((await call("GET", "/v1/auth/token")).status).toBe(404)
	})
})

describe("the health route", () => {
	it("answers ok, or a 500 under PUBLIC_GET_NOT_SUCCESS", async () => {
		expect((await (await api()).call("GET", "/health", { token: null })).body).toEqual({ ok: true })
		const failing = await (await api({ defects: ["PUBLIC_GET_NOT_SUCCESS"] })).call("GET", "/health")
		expect(failing).toMatchObject({ body: { error_key: "internal_server_error" }, status: 500 })
	})
})

describe("the notices routes", () => {
	it("list and read the one notice to an authenticated caller", async () => {
		const { call } = await api()
		expect((await call("GET", "/v1/notices")).body).toEqual({ notices: [{ id: "note_1", title: "Hello" }] })
		expect((await call("GET", "/v1/notices/note_1")).body).toEqual({ id: "note_1", title: "Hello" })
		expect((await call("GET", "/v1/notices/note_2")).status).toBe(404)
		expect((await call("GET", "/v1/notices", { token: null })).status).toBe(401)
		expect((await call("GET", "/v1/notices/note_1", { token: null })).status).toBe(401)
		expect((await call("DELETE", "/v1/notices/note_1")).status).toBe(404)
	})

	it("disagree with the listing under LISTED_GET_DIFFERS", async () => {
		const { call } = await api({ defects: ["LISTED_GET_DIFFERS"] })
		expect((await call("GET", "/v1/notices/note_1")).body.title).toBe("Other")
	})
})

describe("register and logout", () => {
	it("issue a disposable token, and revoke only the caller's", async () => {
		const { call } = await api()
		const { status, body } = await call("POST", "/v1/register", { token: null })
		expect(status).toBe(201)
		const disposable = String(body.access_token)
		expect(disposable).toBe("tok_disp_4")
		expect((await call("GET", "/v1/me", { token: disposable })).status).toBe(200)
		expect((await call("POST", "/v1/logout", { token: disposable })).body).toEqual({ ok: true })
		expect((await call("GET", "/v1/me", { token: disposable })).status).toBe(401)
		expect((await call("GET", "/v1/me")).status).toBe(200)
		expect((await call("POST", "/v1/logout", { token: null })).status).toBe(200)
	})

	it("revoke every token, the suite caller's too, under DISPOSABLE_KILLS_CALLER", async () => {
		const { call } = await api({ defects: ["DISPOSABLE_KILLS_CALLER"] })
		const disposable = String((await call("POST", "/v1/register")).body.access_token)
		await call("POST", "/v1/logout", { token: disposable })
		expect((await call("GET", "/v1/me")).status).toBe(401)
	})
})

describe("the overview route", () => {
	it("answers an authenticated caller, or anyone under ROOT_READ_OPEN", async () => {
		const { call } = await api()
		expect((await call("GET", "/v1/projects/proj_alpha/overview")).body).toEqual({
			extractions: 0,
			project_id: "proj_alpha",
		})
		expect((await call("GET", "/v1/projects/proj_alpha/overview", { token: null })).status).toBe(401)
		expect((await call("POST", "/v1/projects/proj_alpha/overview")).status).toBe(404)
		const open = await api({ defects: ["ROOT_READ_OPEN"] })
		expect((await open.call("GET", "/v1/projects/proj_beta/overview", { token: null })).status).toBe(200)
	})
})

describe("the caller's own record", () => {
	it("reads and updates the caller's profile, per token", async () => {
		const { call } = await api()
		expect((await call("GET", "/v1/me")).body).toEqual({ first_name: "Ada" })
		expect((await call("PATCH", "/v1/me", { body: { first_name: "Grace" } })).body).toEqual({ first_name: "Grace" })
		expect((await call("GET", "/v1/me")).body).toEqual({ first_name: "Grace" })
		expect((await call("GET", "/v1/me", { token: BETA })).body).toEqual({ first_name: "Ada" })
		expect((await call("DELETE", "/v1/me")).status).toBe(404)
	})

	it("refuses a name that is missing, empty, too long or not a string, and a body that is not JSON", async () => {
		const { call } = await api()
		for (const body of ["null", { first_name: "" }, { first_name: "x".repeat(65) }, { first_name: 3 }]) {
			expect((await call("PATCH", "/v1/me", { body })).status).toBe(400)
		}
		expect((await call("PATCH", "/v1/me", { form: "first_name=Grace" })).status).toBe(415)
		expect((await call("PATCH", "/v1/me", { body: {}, token: null })).status).toBe(401)
	})

	it("acknowledges an update it drops under CALLER_UPDATE_DROPPED", async () => {
		const { call } = await api({ defects: ["CALLER_UPDATE_DROPPED"] })
		expect((await call("PATCH", "/v1/me", { body: { first_name: "Grace" } })).body).toEqual({ first_name: "Ada" })
		expect((await call("GET", "/v1/me")).body).toEqual({ first_name: "Ada" })
	})
})
