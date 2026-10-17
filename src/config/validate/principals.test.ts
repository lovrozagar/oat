import { describe, expect, it } from "vitest"
import { placeholders, principalProblems, removedProblems } from "./principals.ts"

describe("principal placeholders", () => {
	it("finds every {principal.<key>} however deeply a recipe nests it", () => {
		const recipe = { login: { steps: [{ body: { a: "{principal.email}", b: ["{principal.password}", 3] } }] } }
		expect([...placeholders(recipe)].toSorted()).toEqual(["email", "password"])
		expect(placeholders(null).size).toBe(0)
	})
})

describe("principalProblems", () => {
	const schemes = new Set(["jwt"])

	it("wants a map", () => {
		expect(principalProblems({ principals: "alpha" }, schemes)).toEqual([
			"principals must be a map of id → identity data",
		])
	})

	it("reads recipes from security only when there is one", () => {
		expect(principalProblems({ principals: { alpha: { tenant: "t" } }, security: [] }, schemes)).toEqual([])
	})
})

describe("removedProblems", () => {
	it("says nothing when no removed field is present", () => {
		expect(removedProblems({ principals: {} })).toEqual([])
	})
})
