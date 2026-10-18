import { describe, expect, it } from "vitest"
import { RECORD_DEFECTS } from "./records.ts"

describe("RECORD_DEFECTS", () => {
	it("holds the family of records, responses, storage and access, in the table's order", () => {
		const names = Object.keys(RECORD_DEFECTS)
		expect(names.slice(0, 3)).toEqual(["SOFT_DELETE_LEAK", "IMMUTABLE_WRITABLE", "SELECT_IGNORED"])
		expect(names.at(-1)).toBe("REVOKE_IGNORED")
	})

	it("names each defect in upper snake case and describes it in one clause", () => {
		for (const [name, description] of Object.entries(RECORD_DEFECTS)) {
			expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
			expect(description.trim()).toBe(description)
			expect(description.length).toBeGreaterThan(10)
			expect(description).not.toMatch(/\.$/)
		}
	})
})
