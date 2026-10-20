import { describe, expect, it } from "vitest"
import type { Recipe } from "../config/types/security.ts"
import { effectiveRecipe, own } from "./effective.ts"

const login = { from: "$.t", steps: [{ operationId: "auth.login" }] } as Recipe["login"]

describe("effectiveRecipe", () => {
	it("is the base when there is no override", () => {
		const base = { format: "Bearer {credential}", login } as Recipe
		expect(effectiveRecipe(base, undefined)).toBe(base)
	})

	it("merges options over the base when the override names no kind", () => {
		expect(effectiveRecipe({ expiresIn: 60, format: "A {credential}", login } as Recipe, { expiresIn: 30 })).toEqual({
			expiresIn: 30,
			format: "A {credential}",
			login,
		})
	})

	it("replaces the base kind when the override names one, keeping the base options", () => {
		expect(effectiveRecipe({ format: "A {credential}", login } as Recipe, { static: "t" })).toEqual({
			format: "A {credential}",
			static: "t",
		})
	})

	it("is the override alone when there is no base", () => {
		expect(effectiveRecipe(undefined, { static: "t" })).toEqual({ static: "t" })
	})
})

describe("effectiveRecipe, options that belong to the kind", () => {
	const base = {
		expiresIn: { from: "$.expires_in" },
		format: "A {credential}",
		holds: ["x"],
		login,
		placements: [{ in: "query", name: "k" }],
		refresh: login,
	} as unknown as Recipe

	it("drops refresh, expiresIn and holds when the override replaces the kind", () => {
		expect(effectiveRecipe(base, { static: "t" })).toEqual({
			format: "A {credential}",
			placements: [{ in: "query", name: "k" }],
			static: "t",
		})
	})

	it("keeps what the override restates", () => {
		expect(effectiveRecipe(base, { expiresIn: 60, static: "t" })).toMatchObject({ expiresIn: 60, static: "t" })
	})
})

describe("own", () => {
	it("reads a config map's own entry, never the prototype's", () => {
		const map: Record<string, number> = { a: 1 }
		expect([own(map, "a"), own(map, "b"), own(map, "constructor")]).toEqual([1, undefined, undefined])
	})
})
