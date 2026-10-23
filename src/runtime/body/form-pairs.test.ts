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

	/* OAS 3.1 Encoding Object: explode defaults to true for form only, false for every other style. */
	it("joins a delimited style that does not say explode, as the OAS default has it", () => {
		expect(formPairs("tag", ["a", "b"], { style: "pipeDelimited" })).toEqual([["tag", "a|b"]])
		expect(formPairs("tag", ["a", "b"], { style: "spaceDelimited" })).toEqual([["tag", "a b"]])
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

	/* OAS 3.1 §4.8.12.4, the style examples for color = {R:100,G:200,B:150} with explode=false. */
	it("joins a non-exploded object with the style's delimiter, as the OAS style table writes it", () => {
		const color = { R: 100, G: 200, B: 150 }
		const wire = (style: string) => encodeUrlencoded({ color }, { color: { explode: false, style } }).toString()
		expect(wire("form")).toBe("color=R%2C100%2CG%2C200%2CB%2C150")
		expect(wire("pipeDelimited")).toBe("color=R%7C100%7CG%7C200%7CB%7C150")
		/* The table's %20; a urlencoded body writes a space as "+". */
		expect(wire("spaceDelimited")).toBe("color=R+100+G+200+B+150")
		expect(formPairs("color", color, { explode: false, style: "spaceDelimited" })).toEqual([
			["color", decodeURIComponent("R%20100%20G%20200%20B%20150")],
		])
	})
})

describe("formPairs per the operation's encoding", () => {
	it("repeats array keys and spreads objects by default", () => {
		expect(formPairs("tags", ["a", "b"], undefined)).toEqual([
			["tags", "a"],
			["tags", "b"],
		])
		expect(formPairs("point", { x: 1, y: 2 }, undefined)).toEqual([
			["x", "1"],
			["y", "2"],
		])
	})

	it("honours deepObject, explode false and a JSON content type", () => {
		expect(formPairs("point", { x: 1 }, { style: "deepObject" })).toEqual([["point[x]", "1"]])
		expect(formPairs("tags", ["a", "b"], { explode: false, style: "pipeDelimited" })).toEqual([["tags", "a|b"]])
		expect(formPairs("meta", { k: 1 }, { contentType: "application/json" })).toEqual([["meta", '{"k":1}']])
	})
})

describe("encodeUrlencoded", () => {
	it("appends every field's pairs, each by its own encoding", () => {
		const params = encodeUrlencoded({ name: "n", none: undefined, tags: ["a", "b"] }, { tags: { explode: false } })
		expect(params.toString()).toBe("name=n&tags=a%2Cb")
		expect(encodeUrlencoded({ tags: ["a", "b"] }).toString()).toBe("tags=a&tags=b")
	})
})
