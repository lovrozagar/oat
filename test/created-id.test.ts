import { describe, expect, it } from "vitest"
import { createdIdOf } from "../src/runtime/effects.ts"

describe("createdIdOf", () => {
	it("prefers the id the create answered with", () => {
		expect(createdIdOf({ requestBody: { id: "sent" }, responseBody: { id: "answered" } }, ["id"])).toBe("answered")
	})

	it("finds an answered id nested in an envelope", () => {
		expect(createdIdOf({ requestBody: undefined, responseBody: { data: { id: 7 } } }, ["id"])).toBe("7")
	})

	it("falls back to the id the client sent when the create only acknowledged", () => {
		expect(createdIdOf({ requestBody: { id: "note-1", name: "a" }, responseBody: { success: true } }, ["id"])).toBe(
			"note-1",
		)
	})

	it("reads the sent id by any of the keys, in order", () => {
		expect(createdIdOf({ requestBody: { note_id: "n1", id: "x" }, responseBody: {} }, ["note_id", "id"])).toBe("n1")
	})

	it("does not dig into nested request fields", () => {
		expect(createdIdOf({ requestBody: { parent: { id: "p" } }, responseBody: {} }, ["id"])).toBeUndefined()
	})

	it("ignores request bodies that are not plain JSON objects", () => {
		const form = new FormData()
		form.set("id", "f1")
		expect(createdIdOf({ requestBody: form, responseBody: {} }, ["id"])).toBeUndefined()
		expect(createdIdOf({ requestBody: [{ id: "a" }], responseBody: {} }, ["id"])).toBeUndefined()
		expect(createdIdOf({ requestBody: "id=1", responseBody: {} }, ["id"])).toBeUndefined()
	})

	it("returns undefined when neither side names an id", () => {
		expect(createdIdOf({ requestBody: { name: "a" }, responseBody: { success: true } }, ["id"])).toBeUndefined()
	})
})
