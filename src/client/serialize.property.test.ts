import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { addRequiredQuery, requestUrl } from "./serialize.ts"

/*
 * A request's query round-trips: what `requestUrl` writes in a declared style, a server's query
 * parser (here the platform's) reads back as the caller's values, and the path's own pairs keep.
 */

const BASE = "https://x.test"
const text = fc.string({ maxLength: 8, unit: "grapheme" })
const name = fc.stringMatching(/^[a-z][a-z0-9_]{0,5}$/).filter((n) => n !== "keep")
const scalar = fc.oneof(text, fc.integer(), fc.boolean())
const items = fc.array(text, { maxLength: 3, minLength: 1 })

describe("requestUrl, by property", () => {
	it("round-trips exploded form values through a query parser, replacing the path's own", () => {
		const query = fc.dictionary(name, fc.oneof(scalar, items), { maxKeys: 3, minKeys: 1, noNullPrototype: true })
		fc.assert(
			fc.property(query, (values) => {
				const [first] = Object.keys(values)
				const url = requestUrl(BASE, `/p?keep=1&${first}=old`, { query: values })
				expect(url.searchParams.getAll("keep")).toEqual(["1"])
				for (const [key, value] of Object.entries(values)) {
					expect(url.searchParams.getAll(key)).toEqual((Array.isArray(value) ? value : [value]).map(String))
				}
			}),
		)
	})

	it("round-trips a deepObject's entries as `name[key]` pairs", () => {
		const flat = fc.dictionary(name, text, { maxKeys: 3, minKeys: 1, noNullPrototype: true })
		fc.assert(
			fc.property(name, flat, (param, value) => {
				const url = requestUrl(BASE, "/p", { query: { [param]: value }, styles: { [param]: { style: "deepObject" } } })
				expect([...url.searchParams]).toEqual(Object.entries(value).map(([key, item]) => [`${param}[${key}]`, item]))
			}),
		)
	})

	it("round-trips a pipe-delimited array whose items carry no pipe", () => {
		const unpiped = fc.array(
			text.filter((item) => !item.includes("|")),
			{ maxLength: 3, minLength: 1 },
		)
		fc.assert(
			fc.property(name, unpiped, (param, value) => {
				const url = requestUrl(BASE, "/p", {
					query: { [param]: value },
					styles: { [param]: { explode: false, style: "pipeDelimited" } },
				})
				expect(url.searchParams.get(param)?.split("|")).toEqual(value)
			}),
		)
	})
})

describe("addRequiredQuery, by property", () => {
	it("adds a required parameter only when neither the caller nor the URL already carries it", () => {
		const names = fc.uniqueArray(name, { maxLength: 4 })
		fc.assert(
			fc.property(names, names, names, (required, set, carried) => {
				const url = new URL(`${BASE}/p?${carried.map((n) => `${n}=c`).join("&")}`)
				const query = Object.fromEntries(set.map((n) => [n, undefined]))
				addRequiredQuery(url, Object.fromEntries(required.map((n) => [n, "r"])), { query })
				for (const n of required) {
					const expected = carried.includes(n) ? ["c"] : set.includes(n) ? [] : ["r"]
					expect(url.searchParams.getAll(n)).toEqual(expected)
				}
			}),
		)
	})
})
