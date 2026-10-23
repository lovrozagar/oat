import { describe, expect, it } from "vitest"
import { documentFixtures, okResponse } from "./documents.ts"

describe("okResponse", () => {
	it("is a 200 JSON response with the schema", () => {
		expect(okResponse({ type: "object" })).toEqual({
			"200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" },
		})
	})
})

describe("documentFixtures", () => {
	it("each says why it is hostile, and what oat must find when that is known", () => {
		for (const fixture of documentFixtures()) {
			expect(fixture.why).not.toBe("")
			expect(fixture.expectOperations).toBeGreaterThanOrEqual(0)
		}
		expect(documentFixtures().map((fixture) => fixture.doc["openapi"])).toEqual([
			"3.1.0",
			"3.1.0",
			"3.1.0",
			"3.0.3",
			"3.1.0",
			"3.1.0",
		])
	})
})
