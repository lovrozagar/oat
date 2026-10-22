import { describe, expect, it } from "vitest"
import { serializeParam, unencodedPairs } from "./param-style.ts"

/* OAS 3.1 §4.8.12.4, the style examples: color = "blue", ["blue","black","brown"], {R:100,G:200,B:150}. */
const VALUES = ["blue", ["blue", "black", "brown"], { R: 100, G: 200, B: 150 }] as const

const query = (style: string, explode: boolean) => (value: unknown) =>
	serializeParam({ explode, in: "query", name: "color", style }, value)
		.map(([key, item]) => `${key}=${item}`)
		.join("&")

const path = (style: string, explode: boolean) => (value: unknown) =>
	serializeParam({ explode, in: "path", name: "color", style }, value)

describe("serializeParam, the OAS style table", () => {
	it.each([
		["matrix", false, [";color=blue", ";color=blue,black,brown", ";color=R,100,G,200,B,150"]],
		["matrix", true, [";color=blue", ";color=blue;color=black;color=brown", ";R=100;G=200;B=150"]],
		["label", false, [".blue", ".blue,black,brown", ".R,100,G,200,B,150"]],
		["label", true, [".blue", ".blue.black.brown", ".R=100.G=200.B=150"]],
		["simple", false, ["blue", "blue,black,brown", "R,100,G,200,B,150"]],
		["simple", true, ["blue", "blue,black,brown", "R=100,G=200,B=150"]],
	] as const)("writes a path parameter in %s style, explode %s", (style, explode, wire) => {
		expect(VALUES.map(path(style, explode))).toEqual(wire)
	})

	it.each([
		["form", false, ["color=blue", "color=blue,black,brown", "color=R,100,G,200,B,150"]],
		["form", true, ["color=blue", "color=blue&color=black&color=brown", "R=100&G=200&B=150"]],
		["spaceDelimited", false, ["color=blue", "color=blue%20black%20brown", "color=R%20100%20G%20200%20B%20150"]],
		["spaceDelimited", true, ["color=blue", "color=blue&color=black&color=brown", "R=100&G=200&B=150"]],
		["pipeDelimited", false, ["color=blue", "color=blue|black|brown", "color=R|100|G|200|B|150"]],
		["pipeDelimited", true, ["color=blue", "color=blue&color=black&color=brown", "R=100&G=200&B=150"]],
		[
			"deepObject",
			false,
			["color=blue", "color=blue&color=black&color=brown", "color[R]=100&color[G]=200&color[B]=150"],
		],
		[
			"deepObject",
			true,
			["color=blue", "color=blue&color=black&color=brown", "color[R]=100&color[G]=200&color[B]=150"],
		],
	] as const)("writes a query parameter in %s style, explode %s", (style, explode, wire) => {
		expect(VALUES.map(query(style, explode))).toEqual(wire)
	})

	it("writes an empty value as the table does", () => {
		expect(["matrix", "label", "simple"].map((style) => path(style, false)(""))).toEqual([";color", ".", ""])
		expect(query("form", true)("")).toBe("color=")
	})
})

describe("serializeParam, defaults and locations", () => {
	it("defaults query and cookie to form exploded, path and header to simple unexploded", () => {
		const [, list, record] = VALUES
		expect(serializeParam({ in: "query", name: "color" }, list)).toEqual([
			["color", "blue"],
			["color", "black"],
			["color", "brown"],
		])
		expect(serializeParam({ in: "cookie", name: "color" }, record)).toEqual([
			["R", "100"],
			["G", "200"],
			["B", "150"],
		])
		expect(serializeParam({ in: "path", name: "color" }, record)).toBe("R,100,G,200,B,150")
		expect(serializeParam({ in: "header", name: "X-Color" }, list)).toBe("blue,black,brown")
	})

	it("percent-encodes every reserved character unless allowReserved, and never a header", () => {
		const text = "a b&c/d!*'()"
		expect(serializeParam({ in: "query", name: "q" }, text)).toEqual([["q", "a%20b%26c%2Fd%21%2A%27%28%29"]])
		expect(serializeParam({ allowReserved: true, in: "query", name: "q" }, text)).toEqual([["q", "a%20b&c/d!*'()"]])
		expect(serializeParam({ in: "path", name: "id" }, "t/1")).toBe("t%2F1")
		expect(serializeParam({ in: "header", name: "X-Q" }, text)).toBe(text)
	})

	it("sends nothing for an absent value, a scalar as its text, and a nested value as JSON", () => {
		expect(serializeParam({ in: "query", name: "q" }, undefined)).toEqual([])
		expect(serializeParam({ in: "cookie", name: "q" }, null)).toEqual([])
		expect(serializeParam({ in: "header", name: "q" }, undefined)).toBe("")
		expect(serializeParam({ in: "header", name: "q" }, false)).toBe("false")
		expect(serializeParam({ explode: false, in: "query", name: "q" }, [{ a: 1 }, null])).toEqual([
			["q", "%7B%22a%22%3A1%7D,null"],
		])
	})
})

describe("unencodedPairs", () => {
	it("writes a form field's pairs as they are, for a body encoder to encode", () => {
		expect(unencodedPairs({ explode: false, name: "tag", style: "spaceDelimited" }, ["a b", "c"])).toEqual([
			["tag", "a b c"],
		])
		expect(unencodedPairs({ name: "f", style: "deepObject" }, { a: "x/y" })).toEqual([["f[a]", "x/y"]])
	})
})
