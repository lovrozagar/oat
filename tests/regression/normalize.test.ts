import { describe, expect, it } from "vitest"
import { normalizeText } from "../support/golden.ts"

/* A golden must not hold anything a run's timing decides: every issued id reads the same. */
describe("normalizeText", () => {
	it("hides an issued id wherever it stands, an encoded separator before it included", () => {
		expect(normalizeText("filter=id.in.%28table_000012%2Ctable_000044%29")).toBe(
			"filter=id.in.%28table_ID%2Ctable_ID%29",
		)
		expect(normalizeText("table_000001,row_000002 x/job_000003")).toBe("table_ID,row_ID x/job_ID")
	})

	it("does not start an id in the middle of a word", () => {
		expect(normalizeText("abcDef_000001")).toBe("abcDef_000001")
	})
})
