import { describe, expect, it } from "vitest"
import { TABLE } from "../model/table.ts"
import { api, MEMBER, TABLES, VIEWER } from "./__fixtures__/api.ts"
import { privilegedFields } from "./privileged.ts"

describe("privilegedFields", () => {
	it("names the table's verified flag, and nothing on an entity without one", () => {
		expect(privilegedFields(TABLE)).toEqual(["verified"])
		expect(privilegedFields({ ...TABLE, fields: [] })).toEqual([])
	})
})

describe("the privileged field", () => {
	it("is false on a new table, and only admin may set it", async () => {
		const { call, table } = await api()
		const created = await table("t")
		expect(created["verified"]).toBe(false)
		const item = `${TABLES}/${String(created["id"])}`
		expect((await call("PATCH", item, { body: { verified: true }, token: MEMBER })).status).toBe(403)
		expect((await call("POST", TABLES, { body: { name: "u", verified: true }, token: MEMBER })).status).toBe(403)
		expect((await call("GET", item)).body["verified"]).toBe(false)
		expect((await call("PATCH", item, { body: { verified: true } })).body["verified"]).toBe(true)
		expect((await call("PATCH", item, { body: { name: "renamed" }, token: MEMBER })).status).toBe(200)
	})

	it("survives a non-admin's replacement, which leaves it out", async () => {
		const { call, table } = await api({ shape: { updateMethod: "PUT" } })
		const item = `${TABLES}/${String((await table("t"))["id"])}`
		await call("PUT", item, { body: { name: "t", verified: true } })
		expect((await call("PUT", item, { body: { name: "again" }, token: MEMBER })).status).toBe(200)
		expect((await call("GET", item)).body).toMatchObject({ name: "again", verified: true })
	})

	it("is set by a member's or a viewer's write under PRIVILEGED_FIELD_WRITABLE", async () => {
		const { call, table } = await api({ defects: ["PRIVILEGED_FIELD_WRITABLE", "ROLE_NOT_CHECKED"] })
		const item = `${TABLES}/${String((await table("t"))["id"])}`
		expect((await call("PATCH", item, { body: { verified: true }, token: MEMBER })).body["verified"]).toBe(true)
		expect((await call("PATCH", item, { body: { verified: false }, token: VIEWER })).body["verified"]).toBe(false)
	})
})

describe("ROLE_NOT_CHECKED", () => {
	it("lets a viewer create, update and delete", async () => {
		const { call } = await api({ defects: ["ROLE_NOT_CHECKED"] })
		const created = await call("POST", TABLES, { body: { name: "v" }, token: VIEWER })
		expect(created.status).toBe(201)
		const item = `${TABLES}/${String(created.body["id"])}`
		expect((await call("PATCH", item, { body: { name: "w" }, token: VIEWER })).status).toBe(200)
		expect((await call("DELETE", item, { token: VIEWER })).status).toBe(200)
	})
})
