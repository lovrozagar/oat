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

	it("hides a JWT whole, header, claims and signature, wherever it stands", () => {
		expect(normalizeText("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.Xy_z-09 next")).toBe("Bearer JWT next")
		expect(normalizeText('"access_token":"eyJa.eyJb.c"')).toBe('"access_token":"JWT"')
	})

	it("hides an issued API key, and leaves a shorter one alone", () => {
		expect(normalizeText("ApiKey ak_0123456789abcdef0123456789abcdef")).toBe("ApiKey ak_KEY")
		expect(normalizeText("ak_0123")).toBe("ak_0123")
	})
})
