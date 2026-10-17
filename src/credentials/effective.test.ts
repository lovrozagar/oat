import { describe, expect, it } from "vitest"
import type { Recipe } from "../config/types/security.ts"
import { effectiveRecipe } from "./effective.ts"

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
