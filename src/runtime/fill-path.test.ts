import { describe, expect, it } from "vitest"
import { fillPath } from "./fill-path.ts"
import { SeedError } from "./seed-error.ts"

describe("fillPath", () => {
	it("fills each parameter, URI-encoded", () => {
		expect(fillPath("/v1/tables/{table_id}/rows/{row_id}", { row_id: "a b", table_id: "t/1" })).toBe(
			"/v1/tables/t%2F1/rows/a%20b",
		)
	})

	it("is a seed failure naming the parameter it had no value for", () => {
		expect(() => fillPath("/v1/tables/{table_id}", {})).toThrow(SeedError)
		expect(() => fillPath("/v1/tables/{table_id}", {})).toThrow(expect.objectContaining({ culprit: "table_id" }))
	})
})
