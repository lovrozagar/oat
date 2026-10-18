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

	it("passes over entities without a create, creates without a body, and failures that are not overflows", () => {
		const fine = modelOf(tables(null))
		probeCreateFixtures(fine)
		expect(fine.gaps.gaps.filter((gap) => gap.tag === "fixture")).toEqual([])
		const bare = modelOf(notes({ body: null }))
		probeCreateFixtures(bare)
		expect(bare.gaps.gaps.filter((gap) => gap.tag === "fixture")).toEqual([])
		const malformed = modelOf(notes({ body: { allOf: [{ allOf: 5 }] } }))
		expect(() => probeCreateFixtures(malformed)).not.toThrow()
		expect(malformed.gaps.gaps.filter((gap) => gap.tag === "fixture")).toEqual([])
	})
})
