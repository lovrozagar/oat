import { describe, expect, it } from "vitest"
import { encodeUrlencoded, formPairs } from "./form-pairs.ts"

describe("formPairs, scalars and JSON", () => {
	it("sends nothing for an absent value, and a scalar as its string", () => {
		expect([formPairs("a", undefined, undefined), formPairs("a", null, undefined)]).toEqual([[], []])
		expect(formPairs("n", 3, undefined)).toEqual([["n", "3"]])
		expect(formPairs("b", false, { style: "form" })).toEqual([["b", "false"]])
	})

	it("sends the whole value as JSON when the encoding says so", () => {
		expect(formPairs("meta", { a: [1] }, { contentType: "application/json" })).toEqual([["meta", '{"a":[1]}']])
	})
})

describe("formPairs, arrays", () => {
	it("repeats the key per item by default, an object item as JSON", () => {
		expect(formPairs("tag", ["a", { b: 1 }, null], undefined)).toEqual([
			["tag", "a"],
			["tag", '{"b":1}'],
			["tag", "null"],
		])
	})

	it("joins with the style's delimiter when not exploded", () => {
		expect(formPairs("tag", ["a", "b"], { explode: false })).toEqual([["tag", "a,b"]])
		expect(formPairs("tag", ["a", "b"], { explode: false, style: "spaceDelimited" })).toEqual([["tag", "a b"]])
		expect(formPairs("tag", ["a", "b"], { explode: false, style: "pipeDelimited" })).toEqual([["tag", "a|b"]])
	})
})

describe("formPairs, objects", () => {
	it("spreads its keys by default, dropping undefined ones", () => {
		expect(formPairs("filter", { a: 1, b: undefined, c: { d: 2 } }, undefined)).toEqual([
			["a", "1"],
			["c", '{"d":2}'],
		])
	})

	it("writes name[key] under deepObject, and one joined pair when not exploded", () => {
		expect(formPairs("filter", { a: 1, b: "x" }, { style: "deepObject" })).toEqual([
			["filter[a]", "1"],
			["filter[b]", "x"],
		])
		expect(formPairs("filter", { a: 1, b: "x" }, { explode: false })).toEqual([["filter", "a,1,b,x"]])
	})
})

describe("encodeUrlencoded", () => {
	it("appends every field's pairs, each by its own encoding", () => {
		const params = encodeUrlencoded({ name: "n", none: undefined, tags: ["a", "b"] }, { tags: { explode: false } })
		expect(params.toString()).toBe("name=n&tags=a%2Cb")
		expect(encodeUrlencoded({ tags: ["a", "b"] }).toString()).toBe("tags=a&tags=b")
	})
})
