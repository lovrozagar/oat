import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import { anyrow, cloudflare, keycloak } from "../../spec/security/__fixtures__/documents.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { declaredEverywhere, originProblems, originViews, scopedRecipes } from "./origins.ts"

const view = (doc: OpenApiDocument) => {
	const model = buildModel(doc)
	return { operations: model.operations, schemes: model.schemes }
}

const ANYROW = view(anyrow)
const CF = view(cloudflare)

describe("originViews", () => {
	it("pairs each declared origin the run loaded with its mapping, in config order", () => {
		const config = { origins: [{ id: "cf", security: { api_key: "k" } }, { id: "gone" }, { id: 3 }, "raw"] }
		expect(originViews(config, { cf: CF })).toEqual([
			{ id: "cf", mapping: { api_key: "k" }, schemes: CF.schemes, view: CF },
		])
		expect(originViews({}, { cf: CF })).toEqual([])
	})
})

describe("declaredEverywhere", () => {
	it("lists the primary's schemes, then each origin's that declares any", () => {
		const views = originViews({ origins: [{ id: "cf" }, { id: "kc" }] }, { cf: CF, kc: view(keycloak) })
		expect(declaredEverywhere(ANYROW, views)).toBe(
			"The document declares: apiKey, jwt; origins.cf declares: api_email, api_key, api_token",
		)
	})
})

describe("scopedRecipes", () => {
	it("names a primary scheme needed with scopes, and the recipe an origin's scoped scheme maps to", () => {
		const views = originViews({ origins: [{ id: "rows", security: { apiKey: "rowKey" } }] }, { rows: ANYROW })
		expect([...scopedRecipes(CF, views)]).toEqual(["rowKey"])
		expect([...scopedRecipes(ANYROW, [])]).toEqual(["apiKey"])
		const unmapped = originViews({ origins: [{ id: "rows" }] }, { rows: ANYROW })
		expect([...scopedRecipes(CF, unmapped)]).toEqual([])
	})
})

describe("originProblems", () => {
	it("asks which recipe an origin scheme takes when a recipe shares its name and no mapping says", () => {
		expect(originProblems({}, { cdn: ANYROW }, new Set(["jwt"]))).toEqual([
			'origins.cdn declares scheme "jwt" too; say which recipe it uses: origins[].security: { jwt: "jwt" }',
		])
		expect(
			originProblems({ origins: [{ id: "cdn", security: { jwt: "jwt" } }] }, { cdn: ANYROW }, new Set(["jwt"])),
		).toEqual([])
	})
})
