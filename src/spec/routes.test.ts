import { describe, expect, it } from "vitest"
import { normalisePath, parseRouteRef, pathTemplateMatches, pathTemplateParams } from "./routes.ts"

describe("normalisePath", () => {
	it("writes `:param` segments as `{param}`", () => {
		expect(normalisePath("/v1/things/:thing_id/rows/:id")).toBe("/v1/things/{thing_id}/rows/{id}")
		expect(normalisePath("/v1/things/{id}")).toBe("/v1/things/{id}")
	})
})

describe("parseRouteRef", () => {
	it("reads a method and a path, upper-casing the method and normalising the path", () => {
		expect(parseRouteRef("  get   /things/:id ")).toEqual({ method: "GET", path: "/things/{id}" })
	})

	it("is null for anything that is not one method and one path", () => {
		expect(parseRouteRef("GET")).toBeNull()
		expect(parseRouteRef("GET /a /b")).toBeNull()
		expect(parseRouteRef("")).toBeNull()
	})
})

describe("pathTemplateMatches", () => {
	it("matches one component per parameter, in either style", () => {
		expect(pathTemplateMatches("/v1/tables/{id}", "/v1/tables/t1")).toBe(true)
		expect(pathTemplateMatches("/v1/tables/:id", "/v1/tables/t1")).toBe(true)
		expect(pathTemplateMatches("/v1/tables/{id}", "/v1/tables/t1/rows")).toBe(false)
	})
})

describe("pathTemplateParams", () => {
	it("returns each parameter's value, percent-decoded", () => {
		expect(pathTemplateParams("/a/{x}/b/:y", "/a/one%20two/b/3")).toEqual({ x: "one two", y: "3" })
	})

	it("keeps a value that is not valid percent-encoding as it was sent", () => {
		expect(pathTemplateParams("/a/{x}", "/a/%E0%A4%A")).toEqual({ x: "%E0%A4%A" })
	})

	it("treats the template's other characters literally", () => {
		expect(pathTemplateParams("/a.json/{x}", "/a.json/1")).toEqual({ x: "1" })
		expect(pathTemplateParams("/a.json/{x}", "/abjson/1")).toBeNull()
	})
})
