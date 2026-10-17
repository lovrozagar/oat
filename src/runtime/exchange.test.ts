import { describe, expect, it } from "vitest"
import {
	bodyByteLength,
	describeRequestBody,
	formDataBytes,
	isBodyRef,
	isFormSnapshot,
	isRawBytes,
	utf8Bytes,
} from "./exchange.ts"

const ref = { bytes: 3, mediaType: "application/pdf", sha256: "ab" }

describe("body shapes", () => {
	it("recognises a stored reference and nothing that merely resembles one", () => {
		expect(isBodyRef(ref)).toBe(true)
		expect([null, "x", [ref], { ...ref, bytes: "3" }, { ...ref, extra: 1 }].map(isBodyRef)).toEqual([
			false,
			false,
			false,
			false,
			false,
		])
	})

	it("recognises a form snapshot and nothing else", () => {
		expect(isFormSnapshot({ parts: [] })).toBe(true)
		expect([null, [], { parts: "x" }, { other: 1, parts: [] }].map(isFormSnapshot)).toEqual([
			false,
			false,
			false,
			false,
		])
	})

	it("tells raw bytes from text", () => {
		expect([new ArrayBuffer(2), new Uint8Array(2), new Blob(["ab"]), "ab"].map(isRawBytes)).toEqual([
			true,
			true,
			true,
			false,
		])
	})
})

describe("body sizes", () => {
	it("counts each kind of body without copying it", () => {
		const form = new FormData()
		form.append("name", "é")
		form.append("file", new Blob(["abc"]), "a.txt")
		expect(bodyByteLength("é")).toBe(2)
		expect(bodyByteLength(form)).toBe(formDataBytes(form))
		expect(formDataBytes(form)).toBe(4 + 80 + 2 + 4 + 80 + 3 + 5)
		expect(bodyByteLength(new URLSearchParams({ a: "b" }))).toBe(3)
		expect(bodyByteLength(new Blob(["abcd"]))).toBe(4)
		expect(bodyByteLength(new ArrayBuffer(5))).toBe(5)
		expect(bodyByteLength(new Uint8Array(6))).toBe(6)
		expect(bodyByteLength({ a: 1 })).toBe(0)
		expect([utf8Bytes(undefined), utf8Bytes("")]).toEqual([0, 0])
	})
})

describe("describeRequestBody", () => {
	it("turns every body kind into something a report can print", () => {
		const form = new FormData()
		form.append("name", "x")
		form.append("file", new Blob(["abc"], { type: "text/plain" }), "a.txt")
		expect(describeRequestBody(undefined)).toBeUndefined()
		expect(describeRequestBody(form)).toEqual({
			file: { bytes: 3, filename: "a.txt", mediaType: "text/plain" },
			name: "x",
		})
		const snapshot = {
			parts: [
				{ field: "name", value: "x" },
				{ bytes: 3, field: "file", filename: "a.txt", mediaType: "text/plain", sha256: "ab" },
			],
		}
		expect(describeRequestBody(snapshot)).toEqual({
			file: { bytes: 3, filename: "a.txt", mediaType: "text/plain" },
			name: "x",
		})
		expect(describeRequestBody(new URLSearchParams({ a: "b" }))).toBe("a=b")
		expect(describeRequestBody(new Uint8Array(4))).toEqual({ bytes: 4 })
		expect(describeRequestBody(ref)).toEqual(ref)
		expect(describeRequestBody({ a: 1 })).toEqual({ a: 1 })
	})
})
