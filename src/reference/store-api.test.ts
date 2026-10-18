import { describe, expect, it } from "vitest"
import { decodeCursor, encodeCursor, SqlError } from "./store-api.ts"

/* What decoding `cursor` throws, or what it answers when it does not throw. */
function refused(cursor: string): unknown {
	try {
		return decodeCursor(cursor)
	} catch (error) {
		return error
	}
}

describe("SqlError", () => {
	it("carries the code a response is built from", () => {
		const error = new SqlError("invalid_filter", "bad filter")
		expect(error).toBeInstanceOf(Error)
		expect({ code: error.code, message: error.message }).toEqual({ code: "invalid_filter", message: "bad filter" })
	})
})

describe("encodeCursor and decodeCursor", () => {
	it("round-trip an id through an opaque base64url token", () => {
		const cursor = encodeCursor("row/1?")
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
		expect(decodeCursor(cursor)).toBe("row/1?")
	})

	it("refuse a token this API did not produce", () => {
		for (const cursor of [
			"not json",
			Buffer.from('{"id":7}').toString("base64url"),
			Buffer.from("{}").toString("base64url"),
		]) {
			expect(refused(cursor)).toMatchObject({
				code: "invalid_cursor",
				message: "cursor is not a value produced by this API",
			})
		}
	})
})
