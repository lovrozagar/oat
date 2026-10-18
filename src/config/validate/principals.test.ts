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

	it("binds parameters only through scope, a map of parameter to string", () => {
		expect(principalProblems({ principals: { alpha: { scope: { project_id: "p1" } } } }, schemes)).toEqual([])
		expect(principalProblems({ principals: { alpha: { scope: "p1" } } }, schemes)).toEqual([
			"principals.alpha.scope must be a map of parameter → value",
		])
		expect(principalProblems({ principals: { alpha: { scope: { project_id: 7, org: "o" } } } }, schemes)).toEqual([
			"principals.alpha.scope.project_id must be a string",
		])
	})

	it("names scope as what replaces roots", () => {
		expect(principalProblems({ principals: { alpha: { roots: { project_id: "p1" } } } }, schemes)).toEqual([
			"principals.alpha.roots was removed in 0.25.0: bind its parameters with principals.alpha.scope and its tenant with tenant",
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

	it("names what replaces top-level roots", () => {
		expect(removedProblems({ roots: { project_id: "p1" } })).toEqual([
			"roots was removed in 0.25.0: bind parameters per principal with principals.<id>.scope",
		])
	})
})
