import { describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { DIALECTS } from "../../src/reference/dialect/presets.ts"
import { deriveQueryConventions } from "../../src/spec/conventions/derive.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument, ParameterObject } from "../../src/spec/types.ts"

/*
 * `searchTerm` is a common name for a free-text search parameter. Unrecognised, every search check
 * stands down on an API that has search. Recognising it must not move any other parameter's role.
 */

const conventionsFor = (name: string) =>
	deriveQueryConventions([{ in: "query", name, schema: { type: "string" } } as ParameterObject], null)

describe("the search role", () => {
	it.each(["searchTerm", "search_term", "SearchTerm", "search-term", "searchterm"])(
		"recognises searchTerm however it is spelled: %s",
		(name) => {
			expect(conventionsFor(name).search).toBe(name)
		},
	)
})

describe("the search role still resolves every reference dialect's own search parameter, and nothing else as search", () => {
	it.each(Object.values(DIALECTS))("$name", async (dialect) => {
		const server = await createMemoryServer({ dialect: dialect.name })
		try {
			const doc = (await (await fetch(`${server.url}/v1/openapi/spec`)).json()) as OpenApiDocument
			const model = buildModel(dereference(doc).doc)
			const searches = new Set(
				model.operations.flatMap((op) => (op.conventions.search === undefined ? [] : [op.conventions.search])),
			)
			expect([...searches]).toEqual([dialect.params.search])
		} finally {
			await server.close()
		}
	})
})
