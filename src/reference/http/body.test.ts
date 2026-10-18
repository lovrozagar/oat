import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import { readJson, requireForm, requireJson } from "./body.ts"
import { HttpError } from "./errors.ts"
import { referenceRequest } from "./wire.ts"

function request(text: string, contentType?: string) {
	const headers: Record<string, string> = contentType === undefined ? {} : { "content-type": contentType }
	return referenceRequest("POST", new URL("http://reference.test/"), headers, async () => text)
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
