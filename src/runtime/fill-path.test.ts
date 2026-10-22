import { describe, expect, it } from "vitest"
import { fillPath } from "./fill-path.ts"
import { SeedError } from "./seed-error.ts"

describe("fillPath", () => {
	it("fills each parameter, URI-encoded", () => {
		expect(fillPath("/v1/tables/{table_id}/rows/{row_id}", { row_id: "a b", table_id: "t/1" })).toBe(
			"/v1/tables/t%2F1/rows/a%20b",
		)
	})

	it("writes a parameter in the label or matrix style the operation declares", () => {
		const styles = { id: { style: "label" }, v: { style: "matrix" } }
		expect(fillPath("/v1/rows/{id}/x{v}", { id: "a b", v: "2" }, styles)).toBe("/v1/rows/.a%20b/x;v=2")
		expect(fillPath("/v1/rows/{id}", { id: "it's" }, {})).toBe("/v1/rows/it%27s")
	})

	it("is a seed failure naming the parameter it had no value for", () => {
		expect(() => fillPath("/v1/tables/{table_id}", {})).toThrow(SeedError)
		expect(() => fillPath("/v1/tables/{table_id}", {})).toThrow(expect.objectContaining({ culprit: "table_id" }))
	})
})
