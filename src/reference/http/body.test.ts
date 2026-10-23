import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import { readFields, readJson, requireForm, requireJson } from "./body.ts"
import { HttpError } from "./errors.ts"
import { referenceRequest } from "./wire.ts"

function request(text: string, contentType?: string) {
	const headers: Record<string, string> = contentType === undefined ? {} : { "content-type": contentType }
	return referenceRequest("POST", new URL("http://reference.test/"), { headers, read: async () => text })
}

const CLEAN = new DefectSet()
const LAX = new DefectSet(["CONTENT_TYPE_NOT_ENFORCED"])

describe("readJson", () => {
	it("parses a JSON body", async () => {
		expect(await readJson(request('{"name":"a"}'))).toEqual({ name: "a" })
	})

	it("reads an empty or blank body as an empty object", async () => {
		expect(await readJson(request(""))).toEqual({})
		expect(await readJson(request("  \n"))).toEqual({})
	})

	it("refuses a body that is not JSON with a 400", async () => {
		await expect(readJson(request("{nope"))).rejects.toMatchObject({
			errorKey: "invalid_input",
			message: "request body is not valid JSON",
			status: 400,
		})
	})
})

describe("requireJson and requireForm", () => {
	it("admit the type the route takes, parameters and all", () => {
		expect(() => requireJson(request("", "application/json; charset=utf-8"), CLEAN)).not.toThrow()
		expect(() => requireForm(request("", "application/x-www-form-urlencoded"), CLEAN)).not.toThrow()
	})

	it("refuse another type, or none, with a 415", () => {
		expect(() => requireJson(request("", "text/plain"), CLEAN)).toThrow(HttpError)
		expect(() => requireJson(request(""), CLEAN)).toThrow("expected application/json")
		expect(() => requireForm(request("", "application/json"), CLEAN)).toThrow(
			expect.objectContaining({ errorKey: "unsupported_media_type", status: 415 }),
		)
	})

	it("admit any type under CONTENT_TYPE_NOT_ENFORCED", () => {
		expect(() => requireJson(request("", "text/plain"), LAX)).not.toThrow()
		expect(() => requireForm(request(""), LAX)).not.toThrow()
	})
})

describe("readFields", () => {
	const JSON_TYPE = "application/json"
	const shape = { email: "string", scopes: "strings" } as const

	it("reads a JSON object holding exactly the named fields, each of its kind", async () => {
		const body = await readFields(request('{"email":"a@b.c","scopes":["x"]}', JSON_TYPE), CLEAN, shape)
		expect(body).toEqual({ email: "a@b.c", scopes: ["x"] })
	})

	it("refuses a missing field, an unknown one, a field of the wrong kind, and a body that is no object", async () => {
		for (const text of [
			'{"email":"a"}',
			'{"email":"a","scopes":[],"extra":1}',
			'{"email":1,"scopes":[]}',
			'{"email":"a","scopes":"x"}',
			'{"email":"a","scopes":[1]}',
			"[]",
			"null",
		]) {
			await expect(readFields(request(text, JSON_TYPE), CLEAN, shape)).rejects.toMatchObject({ status: 400 })
		}
		await expect(readFields(request("{}", JSON_TYPE), CLEAN, shape)).rejects.toThrow('field "email" is required')
	})

	it("refuses a body that is not JSON with a 415", async () => {
		await expect(readFields(request("{}", "text/plain"), CLEAN, {})).rejects.toMatchObject({ status: 415 })
	})

	it("reads an optional boolean when the body holds one, and goes without it otherwise", async () => {
		const optional = { email: "string", staff: "boolean?" } as const
		expect(await readFields(request('{"email":"a","staff":true}', JSON_TYPE), CLEAN, optional)).toEqual({
			email: "a",
			staff: true,
		})
		expect(await readFields(request('{"email":"a"}', JSON_TYPE), CLEAN, optional)).toEqual({ email: "a" })
		await expect(readFields(request('{"email":"a","staff":"yes"}', JSON_TYPE), CLEAN, optional)).rejects.toThrow(
			'field "staff" has the wrong type',
		)
	})
})
