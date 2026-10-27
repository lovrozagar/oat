import { describe, expect, it } from "vitest"
import { buildModel } from "../spec/graph/build.ts"
import { anyrow, cloudflare, immich } from "../spec/security/__fixtures__/documents.ts"
import { mappedPairs, originOnlyRecipes, recipeSchemes } from "./origin-recipes.ts"

const PRIMARY = buildModel(anyrow).schemes
const CF = buildModel(cloudflare).schemes
const IMMICH = buildModel(immich).schemes

describe("mappedPairs", () => {
	it("keeps each mapping of a scheme the origin declares to a recipe name, and nothing raw", () => {
		const mapping = { api_key: "cfKey", api_token: 3, missing: "x" }
		expect(mappedPairs({ mapping, schemes: CF })).toEqual([["api_key", "cfKey"]])
		expect(mappedPairs({ mapping: undefined, schemes: CF })).toEqual([])
		expect(mappedPairs({ mapping: "jwt", schemes: CF })).toEqual([])
	})
})

describe("recipeSchemes", () => {
	it("gives a primary scheme to its own recipe, and an origin's to a name only it maps, the first origin first", () => {
		const origins = [
			{ mapping: { api_key: "edgeKey", api_token: "jwt" }, schemes: CF },
			{ mapping: { api_key: "edgeKey" }, schemes: IMMICH },
		]
		const schemes = recipeSchemes(PRIMARY, origins)
		expect([...schemes.keys()]).toEqual(["apiKey", "jwt", "edgeKey"])
		expect(schemes.get("jwt")).toBe(PRIMARY.get("jwt"))
		expect(schemes.get("edgeKey")).toBe(CF.get("api_key"))
	})
})

describe("originOnlyRecipes", () => {
	it("names the recipes no primary scheme declares", () => {
		const origins = [{ mapping: { api_key: "edgeKey", api_token: "jwt" }, schemes: CF }]
		expect([...originOnlyRecipes(PRIMARY, origins)]).toEqual(["edgeKey"])
		expect([...originOnlyRecipes(PRIMARY, [])]).toEqual([])
	})
})
