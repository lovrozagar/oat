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

	it("reads each parameter's value out of a matching path, URI-decoded", () => {
		expect(
			pathTemplateParams("/v1/projects/{project_id}/tables/{table_id}", "/v1/projects/p%201/tables/t%2F2"),
		).toEqual({ project_id: "p 1", table_id: "t/2" })
		expect(pathTemplateParams("/things/:thing_id", "/things/abc")).toEqual({ thing_id: "abc" })
	})

	it("is null for a path the template does not match, and empty for a template without parameters", () => {
		expect(pathTemplateParams("/v1/tables/{table_id}", "/v1/tables")).toBeNull()
		expect(pathTemplateParams("/v1/tables/{table_id}", "/v1/tables/1/rows")).toBeNull()
		expect(pathTemplateParams("/v1/tables.json", "/v1/tablesxjson")).toBeNull()
		expect(pathTemplateParams("/v1/tables", "/v1/tables")).toEqual({})
	})

	it("keeps a stray percent sign as it was sent", () => {
		expect(pathTemplateParams("/t/{id}", "/t/100%")).toEqual({ id: "100%" })
	})
})
