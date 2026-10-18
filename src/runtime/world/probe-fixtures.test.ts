import { describe, expect, it } from "vitest"
import { modelOf } from "../checks/__fixtures__/harness.ts"
import { notes, tables } from "./__fixtures__/documents.ts"
import { probeCreateFixtures } from "./probe-fixtures.ts"

describe("probeCreateFixtures", () => {
	it("records a gap for a create whose body cannot be generated", () => {
		const impossible = {
			properties: { n: { maximum: 1, minimum: 5, type: "integer" } },
			required: ["n"],
			type: "object",
		}
		const model = modelOf(notes({ body: impossible }))
		probeCreateFixtures(model)
		expect(model.gaps.gaps.map((gap) => `${gap.operationId} ${gap.tag}`)).toContain("note.create fixture")
	})

	it("passes over entities without a create and creates without a body", () => {
		const fine = modelOf(tables(null))
		probeCreateFixtures(fine)
		expect(fine.gaps.gaps.filter((gap) => gap.tag === "fixture")).toEqual([])
		const bare = modelOf(notes({ body: null }))
		probeCreateFixtures(bare)
		expect(bare.gaps.gaps.filter((gap) => gap.tag === "fixture")).toEqual([])
	})

	it("records a malformed schema as a gap naming what is wrong, never silence", () => {
		const malformed = modelOf(notes({ body: { allOf: [{ allOf: 5 }] } }))
		probeCreateFixtures(malformed)
		expect(malformed.gaps.gaps.filter((gap) => gap.tag === "fixture").map((gap) => gap.detail)).toEqual([
			expect.stringContaining("allOf/0/allOf is not a list of schemas"),
		])
	})
})
