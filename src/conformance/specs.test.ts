import { describe, expect, it } from "vitest"
import { specFixtures } from "./specs.ts"

describe("specFixtures", () => {
	it("lists every hostile document once, in the order the parser suite reports them", () => {
		const names = specFixtures().map((fixture) => fixture.name)
		expect(names).toEqual([
			"empty",
			"no-paths-key",
			"recursive-refs",
			"nullable-without-type",
			"root-array-response",
			"missing-operation-ids",
			"multiple-arrays-in-envelope",
			"irregular-plurals",
			"allof-composed-response",
			"deeply-nested-path",
			"external-ref",
			"dangling-ref",
			"scopes-not-a-list",
			"query-roles-by-alias",
			"pagination-only-is-not-query",
		])
	})

	it("builds fresh documents each time, so no run can change another's", () => {
		expect(specFixtures()[0]?.doc).not.toBe(specFixtures()[0]?.doc)
	})
})
