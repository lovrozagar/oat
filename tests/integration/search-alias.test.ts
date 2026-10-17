import { describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http.ts"
import { DIALECTS } from "../../src/reference/dialect.ts"
import { deriveQueryConventions } from "../../src/spec/conventions.ts"
import { buildModel } from "../../src/spec/graph.ts"
import { dereference } from "../../src/spec/load.ts"
import type { OpenApiDocument, ParameterObject } from "../../src/spec/types.ts"

/*
 * `searchTerm` is a common name for a free-text search parameter. Unrecognised, every search check
 * stands down on an API that has search. Recognising it must not move any other parameter's role.
 */

const conventionsFor = (name: string) =>
	deriveQueryConventions([{ in: "query", name, schema: { type: "string" } } as ParameterObject], null)

describe("the search role", () => {
	it("recognises searchTerm however it is spelled", () => {
		for (const name of ["searchTerm", "search_term", "SearchTerm", "search-term", "searchterm"]) {
			expect(conventionsFor(name).search, name).toBe(name)
		}
	})

	it("still resolves every reference dialect's own search parameter, and nothing else as search", async () => {
		for (const dialect of Object.values(DIALECTS)) {
			const server = await createMemoryServer({ dialect: dialect.name })
			try {
				const doc = (await (await fetch(`${server.url}/v1/openapi/spec`)).json()) as OpenApiDocument
				const model = buildModel(dereference(doc).doc)
				const searches = new Set(
					model.operations.flatMap((op) => (op.conventions.search === undefined ? [] : [op.conventions.search])),
				)
				expect([...searches], dialect.name).toEqual([dialect.params.search])
			} finally {
				await server.close()
			}
		}
	})
})
