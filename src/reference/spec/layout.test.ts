import { describe, expect, it } from "vitest"
import { hoistPathParameters } from "./layout.ts"

const ID = { in: "path", name: "id", required: true }
const QUERY = { in: "query", name: "q" }

describe("hoistPathParameters", () => {
	it("moves path parameters onto the path item once, keeping the rest on each operation", () => {
		const hoisted = hoistPathParameters({
			"/things/{id}": {
				delete: { operationId: "delete" },
				get: { operationId: "get", parameters: [ID, QUERY] },
				patch: { operationId: "patch", parameters: [ID] },
			},
		})
		expect(hoisted).toEqual({
			"/things/{id}": {
				parameters: [ID],
				delete: { operationId: "delete", parameters: [] },
				get: { operationId: "get", parameters: [QUERY] },
				patch: { operationId: "patch", parameters: [] },
			},
		})
		expect(Object.keys(hoisted["/things/{id}"] as object)[0]).toBe("parameters")
	})

	it("leaves a path item with no path parameters as it was", () => {
		const item = { get: { operationId: "get", parameters: [QUERY] } }
		expect(hoistPathParameters({ "/things": item })["/things"]).toBe(item)
	})
})
