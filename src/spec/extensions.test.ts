import { describe, expect, it } from "vitest"
import { readQueryCapability } from "./extensions.ts"
import type { Endpoint } from "./types.ts"

/*
 * Without `x-query`, oat guesses which fields a listing sorts by. A parameter of the list's own
 * path — the project every listed record sits under — holds one value across the listing, so
 * ordering by it shows nothing; it is never guessed sortable. It stays filterable.
 */

const endpoint: Endpoint = {
	method: "get",
	op: {
		operationId: "table.list",
		parameters: [
			{ in: "path", name: "project_id", required: true, schema: { type: "string" } },
			{ in: "query", name: "order", schema: { type: "string" } },
			{ in: "query", name: "filter", schema: { type: "string" } },
		],
		responses: {},
	},
	operationId: "table.list",
	path: "/v1/projects/{project_id}/tables",
} as unknown as Endpoint

const item = {
	properties: { id: { type: "string" }, name: { type: "string" }, project_id: { type: "string" } },
	type: "object",
}

describe("a guessed sort", () => {
	it("never names a parameter of the list's own path", () => {
		const capability = readQueryCapability(endpoint, item)
		expect(capability?.source).toBe("heuristic")
		expect(capability?.sortable).toEqual(["id", "name"])
		expect(capability?.filterable).toContain("project_id")
	})
})
