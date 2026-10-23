import { describe, expect, it } from "vitest"
import type { SpecFixture } from "../specs.ts"
import { runParserSuite } from "./parser.ts"

/** An article listing taking `names` as query parameters, under `envelope`'s array keys. */
function articles(names: string[], envelope = ["articles"]): Record<string, unknown> {
	const array = { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" }
	const schema = { properties: Object.fromEntries(envelope.map((key) => [key, array])), type: "object" }
	return {
		openapi: "3.1.0",
		paths: {
			"/articles": {
				get: {
					operationId: "article.list",
					parameters: names.map((name) => ({
						in: "query",
						name,
						schema: name === "per_page" ? { maximum: 50, type: "integer" } : { type: "string" },
					})),
					responses: { "200": { content: { "application/json": { schema } }, description: "ok" } },
				},
			},
		},
	}
}

const EMPTY = { openapi: "3.1.0", paths: {} }

/** The details the suite reports for `doc` judged as the fixture called `name`. */
function details(name: string, doc: Record<string, unknown>, counts: Partial<SpecFixture> = {}): string[] {
	return runParserSuite([{ doc, name, why: "w", ...counts }]).map((r) => `${String(r.ok)} ${r.detail}`)
}

describe("runParserSuite", () => {
	it("passes every case", () => {
		const results = runParserSuite()
		expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([])
		expect(results.length).toBeGreaterThan(0)
	})

	it("fails a fixture modelled with other counts than it states", () => {
		expect(details("counts", EMPTY, { expectEntities: 1, expectOperations: 2 })).toEqual([
			"false expected 2 operation(s), modelled 0; expected 1 entity/entities, modelled 0",
		])
	})

	it("fails a fixture the parser throws on", () => {
		const unreadable = {
			openapi: "3.1.0",
			get paths(): never {
				throw new Error("unreadable")
			},
		}
		expect(details("broken", unreadable)).toEqual(["false threw: unreadable"])
	})

	it("fails an external ref resolved in silence, and a mangled plural", () => {
		expect(details("external-ref", EMPTY)).toEqual(["false external $ref was silently resolved instead of reported"])
		const statuses = articles([])
		const list = (statuses["paths"] as Record<string, { get: Record<string, unknown> }>)["/articles"]?.get ?? {}
		list["x-entity"] = { action: "list", identity: "id", name: "statu" }
		expect(details("irregular-plurals", statuses)).toEqual([expect.stringContaining('entity "statu"')])
	})

	it("names the collection key it resolved instead of the envelope's", () => {
		expect(details("multiple-arrays-in-envelope", EMPTY)).toEqual([
			'false collection key resolved to "none", expected "reports"',
		])
		expect(details("multiple-arrays-in-envelope", articles([]))).toEqual([
			'false collection key resolved to "articles", expected "reports"',
		])
	})

	it("fails a query capability inferred from paging alone", () => {
		expect(details("pagination-only-is-not-query", EMPTY)).toEqual([
			"false query capability inferred from page/limit/status: unknown",
		])
		expect(details("pagination-only-is-not-query", articles(["sort", "q"]))).toEqual([
			"false query capability inferred from page/limit/status: heuristic",
		])
	})

	it("names every query role it resolved otherwise", () => {
		expect(details("query-roles-by-alias", EMPTY)).toEqual([
			"false query source is null, expected heuristic; maxLimit is undefined, expected 50 from per_page.maximum; " +
				"roles resolved to order=undefined select=undefined search=undefined",
		])
		expect(details("query-roles-by-alias", articles(["sort"]))).toEqual([expect.stringContaining("order=sort")])
		expect(details("query-roles-by-alias", articles(["sort", "fields", "per_page"]))).toEqual([
			expect.stringContaining("order=sort select=fields search="),
		])
	})
})

describe("runParserSuite and a dangling ref", () => {
	it("fails one read as a schema with no gap, or as a parameter the operation is sent with", () => {
		expect(details("dangling-ref", EMPTY)).toEqual([
			"false payment.list has no gap for the schema its $ref names but the document lacks; " +
				"refund.list was modelled with a parameter its $ref names but the document lacks",
		])
	})
})

describe("runParserSuite and a scope list that is not an array", () => {
	it("fails one the requirement drops, or that leaves no gap", () => {
		const revoke = { operationId: "RevokeToken", responses: {}, security: [{ other: [] }] }
		expect(details("scopes-not-a-list", { openapi: "3.1.0", paths: { "/r": { post: revoke } } })).toEqual([
			'false RevokeToken\'s requirement read as [[{"scheme":"other","scopes":[]}]], expected oauth2 with no scopes; ' +
				"RevokeToken has no gap for the oauth2 scopes that are not a list",
		])
	})
})
