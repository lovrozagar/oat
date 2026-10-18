import { describe, expect, it } from "vitest"
import type { Recipe } from "../../config/types/security.ts"
import type { SecurityScheme } from "../../spec/security/schemes.ts"
import { answerOf, ctxOf, fakePorts, rejection } from "../__fixtures__/ports.ts"
import { acquireRecipe, recipeKind } from "./acquire.ts"

const OAUTH: SecurityScheme = {
	deprecated: false,
	flows: { clientCredentials: { scopes: [], tokenUrl: "/token" } },
	kind: "oauth2",
	name: "oauth",
}

describe("acquireRecipe", () => {
	it("acquires by the one kind the recipe names", async () => {
		const { ports, recorded } = fakePorts({
			call: () => Promise.resolve(answerOf({ key: "minted" })),
			hook: () => Promise.resolve("hooked"),
			post: () => Promise.resolve(answerOf({ access_token: "granted" })),
			run: () => Promise.resolve({ answer: answerOf({ t: "signed" }), scope: {} }),
		})
		const recipes: Array<Partial<Recipe>> = [
			{ login: { from: "$.t", steps: [{ operationId: "login" }] } },
			{ mint: { from: "$.key", operationId: "mint", with: "jwt" } },
			{ static: "fixed" },
			{ hook: true },
			{ oauth2: { clientId: "c", flow: "clientCredentials" } },
		]
		const values = []
		for (const recipe of recipes) values.push((await acquireRecipe(ctxOf(ports, { scheme: OAUTH }), recipe)).value)
		expect(values).toEqual(["signed", "minted", "fixed", "hooked", "granted"])
		expect([recorded.runs.length, recorded.calls.length, recorded.hooks.length, recorded.posts.length]).toEqual([
			1, 1, 1, 1,
		])
	})

	it("refuses a recipe that names no kind", async () => {
		const { ports } = fakePorts()
		expect((await rejection(acquireRecipe(ctxOf(ports), { format: "X {credential}" }))).message).toBe(
			"the jwt recipe names no kind (login, mint, static, hook or oauth2)",
		)
	})
})

describe("recipeKind", () => {
	it("names the kind, or undefined", () => {
		const recipes: Array<Partial<Recipe>> = [
			{ login: { from: "$.t", steps: [{ operationId: "login" }] } },
			{ mint: { from: "$.key", operationId: "mint", with: "jwt" } },
			{ static: "s" },
			{ hook: true },
			{ oauth2: { clientId: "c", flow: "clientCredentials" } },
			{ format: "{credential}" },
		]
		expect(recipes.map(recipeKind)).toEqual(["login", "mint", "static", "hook", "oauth2", undefined])
	})
})
