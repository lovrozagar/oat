import { describe, expect, it } from "vitest"
import { isQueryEnvelopeRole, mergeEnvelopeNames, QUERY_ENVELOPE_ROLES, readEnvelopeNames } from "./envelope-names.ts"

describe("readEnvelopeNames", () => {
	it("keeps every known role named by a non-empty string", () => {
		const all = { hasMore: "more_ahead", nextCursor: "next_before", total: "tally" }
		expect(readEnvelopeNames(all)).toEqual(all)
	})

	it("drops unknown roles, empty names and names that are not strings", () => {
		expect(readEnvelopeNames({ hasMore: "", limit: "took", nextCursor: "next_before", total: 3 })).toEqual({
			nextCursor: "next_before",
		})
	})

	it("reads nothing from a value that is not an object", () => {
		expect(readEnvelopeNames(undefined)).toBeUndefined()
		expect(readEnvelopeNames("next_before")).toBeUndefined()
		expect(readEnvelopeNames(["next_before"])).toBeUndefined()
		expect(readEnvelopeNames(null)).toBeUndefined()
	})
})

describe("QUERY_ENVELOPE_ROLES", () => {
	it("lists the three facts a walk reads from a response", () => {
		expect(QUERY_ENVELOPE_ROLES).toEqual(["total", "hasMore", "nextCursor"])
		expect(isQueryEnvelopeRole("nextCursor")).toBe(true)
		expect(isQueryEnvelopeRole("page")).toBe(false)
	})
})

describe("mergeEnvelopeNames", () => {
	it("lays the config's names over the tag's where the response's envelope holds them", () => {
		const declared = ["events", "next_before", "tally"]
		expect(
			mergeEnvelopeNames({
				config: { nextCursor: "next_before", total: "elsewhere" },
				declared,
				tag: { hasMore: "more_ahead", nextCursor: "nope", total: "tally" },
			}),
		).toEqual({ hasMore: "more_ahead", nextCursor: "next_before", total: "tally" })
		expect(mergeEnvelopeNames({ declared, tag: "x" })).toEqual({})
	})
})
