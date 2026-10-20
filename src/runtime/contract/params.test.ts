import { describe, expect, it } from "vitest"
import { Redactor } from "../../security/redact.ts"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { exampleOf, parametersOf, seenValue, snippet } from "./params.ts"

describe("parametersOf", () => {
	it("reads the declared list, or none", () => {
		expect(parametersOf({ parameters: [{ in: "path", name: "a" }], responses: {} } as never)).toEqual([
			{ in: "path", name: "a" },
		])
		expect(parametersOf({ responses: {} } as never)).toEqual([])
	})
})

describe("exampleOf", () => {
	it("takes the first enum value, the default, or a value of the type", () => {
		expect(exampleOf({ enum: ["b", "c"] })).toBe("b")
		expect(exampleOf({ default: 3, enum: [] })).toBe("3")
		expect(exampleOf({ type: "integer" })).toBe("1")
		expect(exampleOf({ type: "number" })).toBe("1")
		expect(exampleOf({ type: "boolean" })).toBe("true")
		expect(exampleOf({ type: "string" })).toBe("oat")
		expect(exampleOf({ type: "object" })).toBeUndefined()
		expect(exampleOf(undefined)).toBeUndefined()
	})
})

describe("seenValue", () => {
	it("reads the newest success that returned the name, a few levels down", () => {
		const transcript = [
			exchange("GET", "/a", { body: { thing_id: "old" }, status: 200 }),
			exchange("GET", "/b", { body: { items: [{ thing_id: 7 }] }, status: 200 }),
			exchange("GET", "/c", { body: { thing_id: "refused" }, status: 403 }),
			exchange("GET", "/d", { body: { other: "x" }, status: 200 }),
		]
		expect(seenValue(transcript, "thing_id", new Redactor())).toBe("7")
		expect(seenValue(transcript, "missing", new Redactor())).toBeUndefined()
		expect(
			seenValue([exchange("GET", "/e", { body: { thing_id: "" }, status: 200 })], "thing_id", new Redactor()),
		).toBeUndefined()
		expect(
			seenValue([exchange("GET", "/f", { body: { thing_id: true }, status: 200 })], "thing_id", new Redactor()),
		).toBeUndefined()
		expect(seenValue([exchange("GET", "/g", { status: 302 })], "thing_id", new Redactor())).toBeUndefined()
	})

	it("never draws a credential: after a login, neither its access nor its refresh token is a candidate", () => {
		const redactor = new Redactor()
		redactor.registerSecret("acc-9f8e7d6c5b")
		redactor.registerSecret("ref-1a2b3c4d5e")
		const transcript = [
			exchange("GET", "/invites", { body: { token: "inv-0001", refresh_token: "plain-77" }, status: 200 }),
			exchange("POST", "/auth/login", {
				body: { session: { token: "acc-9f8e7d6c5b" }, refresh_token: "ref-1a2b3c4d5e", access_token: "acc-9f8e7d6c5b" },
				status: 200,
			}),
		]
		expect(seenValue(transcript, "token", redactor)).toBe("inv-0001")
		expect(seenValue(transcript, "refresh_token", redactor)).toBe("plain-77")
		expect(seenValue(transcript, "access_token", redactor)).toBeUndefined()
	})

	it("stops five levels down", () => {
		let deep: unknown = { thing_id: "deep" }
		for (let i = 0; i < 6; i++) deep = { nest: deep }
		expect(seenValue([exchange("GET", "/h", { body: deep, status: 200 })], "thing_id", new Redactor())).toBeUndefined()
	})
})

describe("snippet", () => {
	it("is the body's first 160 characters, as text", () => {
		expect(snippet("x".repeat(200))).toHaveLength(160)
		expect(snippet({ a: 1 })).toBe('{"a":1}')
		expect(snippet(undefined)).toBe("")
	})
})
