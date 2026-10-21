import { describe, expect, it } from "vitest"
import { answerOf, ctxOf, fakePorts } from "../__fixtures__/ports.ts"
import { answered, assertHolds, valueAt } from "./answer.ts"

describe("answered", () => {
	it("passes a 2xx answer and refuses any other with its status", () => {
		expect(() => answered(answerOf({}, 201), "mint apiKey.create")).not.toThrow()
		expect(() => answered(answerOf({}, 403), "mint apiKey.create")).toThrow("mint apiKey.create answered 403")
		expect(() => answered(answerOf({}, 302), "x")).toThrow("x answered 302")
	})
})

describe("valueAt", () => {
	it("is the credential at the address, or a reason naming the address", () => {
		expect(valueAt(answerOf({ key: "k" }), "$.key", "mint")).toBe("k")
		expect(() => valueAt(answerOf({}), "$.key", "mint")).toThrow(
			"mint answered no credential at $.key (its answer names no content type)",
		)
		const plain = { ...answerOf("key=k"), headers: { "content-type": "text/plain" } }
		expect(() => valueAt(plain, "key", "mint")).toThrow("mint answered no credential at key (its answer is text/plain)")
	})
})

describe("assertHolds", () => {
	const { ports } = fakePorts()

	it("passes when the credential holds every scope asked for, or none is asked", () => {
		expect(() => assertHolds(ctxOf(ports, { scopes: ["read"] }), ["read", "write"])).not.toThrow()
		expect(() => assertHolds(ctxOf(ports), undefined)).not.toThrow()
	})

	it("names the scopes it does not hold", () => {
		expect(() => assertHolds(ctxOf(ports, { scopes: ["admin", "read", "write"] }), ["read"])).toThrow(
			'the "jwt" credential does not hold admin, write',
		)
	})
})
