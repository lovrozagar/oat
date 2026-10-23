import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { CREDENTIAL_HEADERS } from "./credential-names.ts"
import { credentialHeaderNames, stripCredentials, stripQuery } from "./strip.ts"

/*
 * Redirect stripping over arbitrary headers and queries: every credential placement it is given
 * goes, in any casing for a header, and every other value stays as it was.
 */

/* A small pool of names, the built-in credential headers among them, so collisions are common. */
const token = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,6}$/)
const headerName = fc.oneof(token, fc.constantFrom(...CREDENTIAL_HEADERS, "Authorization", "X-API-Key", "Cookie"))
const headers = fc.dictionary(headerName, fc.string({ maxLength: 8 }), { maxKeys: 6, noNullPrototype: true })
const paramName = fc.constantFrom("key", "api_key", "q", "page", "Key", "a b", "x[y]")
const pairs = fc.array(fc.tuple(paramName, fc.string({ maxLength: 6 })), { maxLength: 8 })

describe("credentialHeaderNames, by property", () => {
	it("holds every built-in name and each injected one lowercased, and nothing in another case", () => {
		fc.assert(
			fc.property(fc.array(token, { maxLength: 4 }), (injected) => {
				const names = credentialHeaderNames(injected)
				expect([...CREDENTIAL_HEADERS].every((name) => names.has(name))).toBe(true)
				expect(injected.every((name) => names.has(name.toLowerCase()))).toBe(true)
				expect([...names].every((name) => name === name.toLowerCase())).toBe(true)
			}),
		)
	})
})

describe("stripCredentials, by property", () => {
	it("removes exactly the credential headers, any casing, and keeps every other header as it was", () => {
		fc.assert(
			fc.property(headers, fc.array(token, { maxLength: 3 }), (sent, injected) => {
				const names = credentialHeaderNames(injected)
				const out = { ...sent }
				stripCredentials(out, names)
				const kept = Object.entries(sent).filter(([name]) => !names.has(name.toLowerCase()))
				expect(out).toEqual(Object.fromEntries(kept))
				stripCredentials(out, names)
				expect(out).toEqual(Object.fromEntries(kept))
			}),
		)
	})
})

describe("stripQuery, by property", () => {
	it("removes every occurrence of each placed parameter and keeps the rest in order", () => {
		fc.assert(
			fc.property(pairs, fc.uniqueArray(paramName, { maxLength: 3 }), (query, placed) => {
				const url = new URL(`https://elsewhere.test/cb?${new URLSearchParams(query)}#frag`)
				stripQuery(url, new Set(placed))
				expect([...url.searchParams]).toEqual(query.filter(([name]) => !placed.includes(name)))
				expect(url.hash).toBe("#frag")
				expect(url.pathname).toBe("/cb")
			}),
		)
	})
})
