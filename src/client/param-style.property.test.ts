import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ParamIn } from "../spec/graph/parameters.ts"
import { serializeParam } from "./param-style.ts"

/*
 * The serializer against an independent reference of the OAS 3.1 style table (§4.8.12.4, the
 * `color` examples), for primitives, arrays and flat objects, and against RFC 3986 encoding.
 */

type Shape = { scalar: string } | { items: string[] } | { entries: Array<[string, string]> }
type Encode = (text: string) => string

const UNRESERVED = /^[A-Za-z0-9._~-]$/
const RESERVED = /^[:/?#[\]@!$&'()*+,;=]$/

/* Percent-encodes every UTF-8 byte of a character outside `keep`, in uppercase hex. */
const percent =
	(keep: (char: string) => boolean): Encode =>
	(text) =>
		[...text]
			.map((char) =>
				keep(char)
					? char
					: [...new TextEncoder().encode(char)]
							.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
							.join(""),
			)
			.join("")
const strict = percent((char) => UNRESERVED.test(char))
const reservedKept = percent((char) => UNRESERVED.test(char) || RESERVED.test(char))

const shapeOf = (value: unknown, encode: Encode): Shape => {
	if (Array.isArray(value)) return { items: value.map((item) => encode(String(item))) }
	if (typeof value !== "object" || value === null) return { scalar: encode(String(value)) }
	return { entries: Object.entries(value).map(([key, item]): [string, string] => [encode(key), encode(String(item))]) }
}
const pieces = (shape: Shape, explode: boolean, joiner: string): string[] => {
	if ("scalar" in shape) return [shape.scalar]
	if ("items" in shape) return shape.items
	return explode ? shape.entries.map(([key, item]) => `${key}${joiner}${item}`) : shape.entries.flat()
}

/** One row of the table: its style, whether it explodes, and the parameter's name. */
interface Row {
	style: string
	explode: boolean
	name: string
}

/* The table's path and header rows: simple, label and matrix. */
function stringRow({ style, explode, name }: Row, shape: Shape): string {
	const parts = pieces(shape, explode, "=")
	if (style === "simple") return parts.join(",")
	if (style === "label") return `.${parts.join(explode ? "." : ",")}`
	if ("scalar" in shape) return shape.scalar === "" ? `;${name}` : `;${name}=${shape.scalar}`
	if (!explode) return `;${name}=${parts.join(",")}`
	return "items" in shape ? parts.map((part) => `;${name}=${part}`).join("") : parts.map((part) => `;${part}`).join("")
}

/* The table's query rows: form, spaceDelimited, pipeDelimited and deepObject, as a query string. */
function queryRow({ style, explode, name }: Row, shape: Shape): string {
	if (style === "deepObject" && "entries" in shape) return shape.entries.map(([k, v]) => `${name}[${k}]=${v}`).join("&")
	if (explode && "items" in shape) return shape.items.map((item) => `${name}=${item}`).join("&")
	if (explode && "entries" in shape) return pieces(shape, true, "=").join("&")
	const delimiter = { pipeDelimited: "|", spaceDelimited: "%20" }[style] ?? ","
	return `${name}=${pieces(shape, false, "=").join(delimiter)}`
}

const safe = fc.stringMatching(/^[A-Za-z0-9._~-]{0,5}$/)
const name = fc.stringMatching(/^[a-z][a-z0-9]{0,4}$/)
const scalar = fc.oneof(safe, fc.integer(), fc.boolean())
const items = fc.array(safe, { maxLength: 3, minLength: 1 })
const flat = fc
	.uniqueArray(fc.tuple(name, fc.oneof(safe, fc.integer())), { maxLength: 3, minLength: 1, selector: ([key]) => key })
	.map((entries) => Object.fromEntries(entries))
const value = fc.oneof(scalar, items, flat)

const queryString = (pairs: Array<[string, string]>) => pairs.map(([key, item]) => `${key}=${item}`).join("&")

describe("the reference", () => {
	const blue = { scalar: "blue" }
	const colors = { items: ["blue", "black", "brown"] }
	const rgb: Shape = {
		entries: [
			["R", "100"],
			["G", "200"],
			["B", "150"],
		],
	}
	const row = (render: typeof stringRow, style: string, explode: boolean) =>
		[{ scalar: "" }, blue, colors, rgb].map((shape) => render({ explode, name: "color", style }, shape))

	it("reproduces the specification's table for `color`", () => {
		expect(row(stringRow, "matrix", false)).toEqual([
			";color",
			";color=blue",
			";color=blue,black,brown",
			";color=R,100,G,200,B,150",
		])
		expect(row(stringRow, "matrix", true)).toEqual([
			";color",
			";color=blue",
			";color=blue;color=black;color=brown",
			";R=100;G=200;B=150",
		])
		expect(row(stringRow, "label", false)).toEqual([".", ".blue", ".blue,black,brown", ".R,100,G,200,B,150"])
		expect(row(stringRow, "label", true)).toEqual([".", ".blue", ".blue.black.brown", ".R=100.G=200.B=150"])
		expect(row(stringRow, "simple", false)).toEqual(["", "blue", "blue,black,brown", "R,100,G,200,B,150"])
		expect(row(stringRow, "simple", true)).toEqual(["", "blue", "blue,black,brown", "R=100,G=200,B=150"])
		expect(row(queryRow, "form", false)).toEqual([
			"color=",
			"color=blue",
			"color=blue,black,brown",
			"color=R,100,G,200,B,150",
		])
		expect(row(queryRow, "form", true)).toEqual([
			"color=",
			"color=blue",
			"color=blue&color=black&color=brown",
			"R=100&G=200&B=150",
		])
		expect(row(queryRow, "spaceDelimited", false).slice(2)).toEqual([
			"color=blue%20black%20brown",
			"color=R%20100%20G%20200%20B%20150",
		])
		expect(row(queryRow, "pipeDelimited", false).slice(2)).toEqual([
			"color=blue|black|brown",
			"color=R|100|G|200|B|150",
		])
		expect(queryRow({ explode: true, name: "color", style: "deepObject" }, rgb)).toBe(
			"color[R]=100&color[G]=200&color[B]=150",
		)
	})
})

describe("serializeParam against the OAS 3.1 style table", () => {
	it("writes path and header values as the simple, label and matrix rows do", () => {
		const where = fc.oneof(
			fc.record({ at: fc.constant<ParamIn>("path"), style: fc.constantFrom("simple", "label", "matrix") }),
			fc.record({ at: fc.constant<ParamIn>("header"), style: fc.constant("simple") }),
		)
		fc.assert(
			fc.property(
				fc.record({ explode: fc.boolean(), param: name, v: value, where }),
				({ explode, param, v, where: { at, style } }) => {
					const out = serializeParam({ explode, in: at, name: param, style }, v)
					expect(out).toBe(
						stringRow(
							{ explode, name: param, style },
							shapeOf(v, (text) => text),
						),
					)
				},
			),
		)
	})

	it("writes query values as the form, delimited and deepObject rows do", () => {
		const row = fc.oneof(
			fc.record({ explode: fc.boolean(), style: fc.constant("form"), v: value }),
			fc.record({
				explode: fc.constant(false),
				style: fc.constantFrom("spaceDelimited", "pipeDelimited"),
				v: fc.oneof(items, flat),
			}),
			fc.record({ explode: fc.constant(true), style: fc.constant("deepObject"), v: flat }),
		)
		fc.assert(
			fc.property(row, name, ({ explode, style, v }, param) => {
				const out = queryString(serializeParam({ explode, in: "query", name: param, style }, v))
				expect(out).toBe(
					queryRow(
						{ explode, name: param, style },
						shapeOf(v, (text) => text),
					),
				)
			}),
		)
	})
})

describe("serializeParam defaults, by property", () => {
	it("defaults query and cookie to exploded form, and path and header to unexploded simple", () => {
		fc.assert(
			fc.property(fc.constantFrom<ParamIn>("query", "cookie", "path", "header"), name, value, (at, param, v) => {
				const pairs = at === "query" || at === "cookie"
				const style = pairs ? "form" : "simple"
				expect(serializeParam({ in: at, name: param }, v)).toEqual(
					serializeParam({ explode: pairs, in: at, name: param, style }, v),
				)
			}),
		)
	})

	it("sends nothing for an absent value", () => {
		fc.assert(
			fc.property(
				fc.constantFrom<ParamIn>("query", "cookie", "path", "header"),
				fc.constantFrom(null, undefined),
				(at, v) => {
					expect(serializeParam({ in: at, name: "p" }, v)).toEqual(at === "query" || at === "cookie" ? [] : "")
				},
			),
		)
	})
})

describe("serializeParam's percent-encoding", () => {
	const text = fc.string({ maxLength: 8, unit: "grapheme" })
	const textItems = fc.array(text, { maxLength: 3, minLength: 1 })

	it("encodes every character outside RFC 3986's unreserved set, name and value", () => {
		fc.assert(
			fc.property(
				text,
				fc.oneof(text, textItems),
				fc.constantFrom("query" as const, "cookie" as const),
				(param, v, at) => {
					const pairs = serializeParam({ in: at, name: param }, v)
					expect(pairs).toEqual(expectedPairs(param, v))
					for (const piece of pairs.flat()) expect(piece).toMatch(/^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})*$/)
				},
			),
		)
	})
})

describe("serializeParam's percent-encoding, by location", () => {
	const text = fc.string({ maxLength: 8, unit: "grapheme" })

	it("keeps reserved characters raw under allowReserved, and encodes the rest", () => {
		fc.assert(
			fc.property(text, (v) => {
				expect(serializeParam({ allowReserved: true, in: "query", name: "p" }, v)).toEqual([["p", reservedKept(v)]])
				expect(serializeParam({ allowReserved: true, in: "path", name: "p" }, v)).toBe(reservedKept(v))
			}),
		)
	})

	it("encodes a path value strictly and never encodes a header", () => {
		fc.assert(
			fc.property(text, (v) => {
				expect(serializeParam({ in: "path", name: "p" }, v)).toBe(strict(v))
				expect(serializeParam({ in: "header", name: "p" }, v)).toBe(v)
			}),
		)
	})
})

/* Exploded form pairs, each name and value encoded strictly. */
function expectedPairs(param: string, v: string | string[]): Array<[string, string]> {
	return (Array.isArray(v) ? v : [v]).map((item): [string, string] => [strict(param), strict(item)])
}
