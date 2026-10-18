import { describe, expect, it } from "vitest"
import { isParamSegment, pathShape, segmentsOf, templateKey } from "./segments.ts"

describe("path segments", () => {
	it("tell a whole `{param}` from a literal", () => {
		expect([isParamSegment("{id}"), isParamSegment("id"), isParamSegment("{a}.json"), isParamSegment("{}")]).toEqual([
			true,
			false,
			false,
			false,
		])
	})

	it("split a path into its non-empty segments", () => {
		expect(segmentsOf("/v1//things/{id}/")).toEqual(["v1", "things", "{id}"])
	})

	it("write every parameter as `{}`, so templates differing only in names compare equal", () => {
		expect(templateKey(["things", "{thing_id}"])).toBe("things/{}")
		expect(pathShape("/things/{id}/rows")).toBe(pathShape("/things/{thingId}/rows"))
	})
})
