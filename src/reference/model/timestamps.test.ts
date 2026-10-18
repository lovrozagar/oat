import { describe, expect, it } from "vitest"
import { TIMESTAMPS } from "./timestamps.ts"

describe("TIMESTAMPS", () => {
	it("are two server-set integers every listing may filter and sort on", () => {
		expect(TIMESTAMPS.map((field) => field.name)).toEqual(["created_at", "updated_at"])
		for (const field of TIMESTAMPS) {
			expect(field).toMatchObject({ filterable: true, generated: true, sortable: true, type: "integer" })
		}
	})
})
