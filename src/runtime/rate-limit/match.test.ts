import { describe, expect, it } from "vitest"
import { rateLimitedModel } from "./__fixtures__/model.ts"
import { compileMatch, compilePathPattern, operationTest } from "./match.ts"

describe("compilePathPattern", () => {
	it("reads a template's parameters and a bare * as one whole segment", () => {
		const template = compilePathPattern("/v1/items/{id}")
		expect(["/v1/items/42", "/v1/items/42/x", "/v1/items/"].map((p) => template.test(p))).toEqual([true, false, false])
		const glob = compilePathPattern("/v1/*/rows")
		expect(["/v1/a/rows", "/v1/a/b/rows"].map((p) => glob.test(p))).toEqual([true, false])
	})

	it("reads * inside a segment as a prefix that never crosses a /, and everything else literally", () => {
		const prefix = compilePathPattern("/v1/item-*")
		expect(["/v1/item-", "/v1/item-7", "/v1/item-7/x"].map((p) => prefix.test(p))).toEqual([true, true, false])
		const literal = compilePathPattern("/v1/a.b+(c)")
		expect(["/v1/a.b+(c)", "/v1/aXbb(c)"].map((p) => literal.test(p))).toEqual([true, false])
	})
})

describe("operationTest", () => {
	it("matches by operationId when the request has one, by method and path otherwise", () => {
		const get = rateLimitedModel().byOperationId.get("items.get")
		if (get === undefined) throw new Error("fixture lost items.get")
		const test = operationTest(get)
		expect(test("POST", "/elsewhere", "items.get")).toBe(true)
		expect(test("GET", "/v1/items/1", "items.list")).toBe(false)
		expect(test("GET", "/v1/items/1")).toBe(true)
		expect(test("DELETE", "/v1/items/1")).toBe(false)
	})
})

describe("compileMatch", () => {
	it("compiles a category to every operation tagged with it", () => {
		const model = rateLimitedModel()
		const read = compileMatch("category: items.read", model)
		expect(read.map((rule) => rule.category)).toEqual(["items.read", "items.read"])
		expect(read.map((rule) => rule.test("GET", "/x", "items.get"))).toEqual([false, true])
		expect(compileMatch("category:nothing", model)).toEqual([])
	})

	it("compiles an operationId to that operation, under its own name", () => {
		const [rule] = compileMatch("items.create", rateLimitedModel())
		expect(rule?.category).toBe("items.create")
		expect(rule?.test("POST", "/v1/items")).toBe(true)
	})

	it("compiles a path pattern, with or without a method", () => {
		const model = rateLimitedModel()
		const [posts] = compileMatch("post /v1/*", model)
		expect(posts?.category).toBe("post /v1/*")
		expect([posts?.test("POST", "/v1/items"), posts?.test("GET", "/v1/items")]).toEqual([true, false])
		const [any] = compileMatch("/v1/items/*", model)
		expect([
			any?.test("GET", "/v1/items/1"),
			any?.test("DELETE", "/v1/items/1"),
			any?.test("GET", "/v1/items"),
		]).toEqual([true, true, false])
	})
})
