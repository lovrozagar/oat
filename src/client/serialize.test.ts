import { describe, expect, it } from "vitest"
import { addRequiredQuery, carriesMissingValue, encodeBody, requestUrl } from "./serialize.ts"

const BASE = "http://api.test/v1"

describe("requestUrl", () => {
	it("puts a path under the base, and keeps an absolute one", () => {
		expect(requestUrl(BASE, "/rows", undefined).toString()).toBe("http://api.test/v1/rows")
		expect(requestUrl(BASE, "https://cdn.test/a", undefined).toString()).toBe("https://cdn.test/a")
	})

	it("sets each query value, repeats an array, and leaves undefined out", () => {
		const url = requestUrl(BASE, "/rows?keep=1", { f: ["a", 2], g: "c", n: 3, none: undefined })
		expect(url.search).toBe("?keep=1&f=a&f=2&g=c&n=3")
	})
})

describe("addRequiredQuery", () => {
	it("adds a required parameter nobody set", () => {
		const url = new URL(`${BASE}/rows`)
		addRequiredQuery(url, { tenant: "t1" }, undefined)
		expect(url.search).toBe("?tenant=t1")
	})

	it("leaves one the caller names, even as undefined, or the URL already has", () => {
		const url = new URL(`${BASE}/rows?page=2`)
		addRequiredQuery(url, { page: "1", tenant: "t1" }, { tenant: undefined })
		expect(url.search).toBe("?page=2")
	})
})

describe("carriesMissingValue", () => {
	it("finds the text undefined in a path segment, encoded or not, or a query value", () => {
		expect(carriesMissingValue(new URL(`${BASE}/rows/undefined`))).toBe(true)
		expect(carriesMissingValue(new URL(`${BASE}/rows/%75ndefined`))).toBe(true)
		expect(carriesMissingValue(new URL(`${BASE}/rows?id=undefined`))).toBe(true)
	})

	it("passes a value that only contains it, and a segment that does not decode", () => {
		expect(carriesMissingValue(new URL(`${BASE}/rows/undefined-ish`))).toBe(false)
		expect(carriesMissingValue(new URL(`${BASE}/rows/%E0%A4%A`))).toBe(false)
	})
})

describe("encodeBody", () => {
	it("sends nothing for no body", () => {
		expect(encodeBody(undefined, undefined)).toEqual({ bytes: 0 })
	})

	it("sends JSON with its type unless one is given", () => {
		expect(encodeBody({ a: "é" }, undefined)).toEqual({
			bytes: 10,
			contentType: "application/json",
			init: '{"a":"é"}',
			text: '{"a":"é"}',
		})
		expect(encodeBody([1], "application/merge-patch+json").contentType).toBe("application/merge-patch+json")
	})

	it("leaves a form's type to fetch, so the boundary survives", () => {
		const form = new FormData()
		form.append("a", "b")
		const encoded = encodeBody(form, "multipart/form-data")
		expect(encoded.init).toBe(form)
		expect(encoded.contentType).toBeUndefined()
		expect(encoded.bytes).toBeGreaterThan(0)
	})

	it("sends URL-encoded fields with their type unless one is given", () => {
		const params = new URLSearchParams({ a: "1", b: "x y" })
		expect(encodeBody(params, undefined)).toEqual({
			bytes: 9,
			contentType: "application/x-www-form-urlencoded",
			init: params,
			text: "a=1&b=x+y",
		})
		expect(encodeBody(params, "text/plain").contentType).toBe("text/plain")
	})

	it("sends text and bytes as they are, typed only when asked", () => {
		expect(encodeBody("hi", undefined)).toEqual({ bytes: 2, init: "hi", text: "hi" })
		expect(encodeBody("hi", "text/csv")).toEqual({ bytes: 2, contentType: "text/csv", init: "hi", text: "hi" })
		const bytes = new Uint8Array([1, 2, 3])
		expect(encodeBody(bytes, undefined)).toEqual({ bytes: 3, init: bytes })
	})

	it("sends a body as it is when headers are final, falling back to JSON", () => {
		const blob = new Blob(["abcd"])
		expect(encodeBody(blob, null)).toMatchObject({ init: blob })
		const stream = new ReadableStream()
		expect(encodeBody(stream, null)).toMatchObject({ init: stream })
		expect(encodeBody("raw", null)).toMatchObject({ init: "raw", text: "raw" })
		expect(encodeBody(new URLSearchParams({ a: "1" }), null).init).toBeInstanceOf(URLSearchParams)
		expect(encodeBody({ a: 1 }, null)).toMatchObject({ init: '{"a":1}' })
		expect(encodeBody({ a: 1 }, null).contentType).toBeUndefined()
	})
})
