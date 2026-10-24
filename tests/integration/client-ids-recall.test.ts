import { describe, expect, it } from "vitest"
import { judgeDefect } from "../../src/conformance/matrix/cases.ts"
import { listening } from "../../src/conformance/harness/launch.ts"

/*
 * Behind the client-ids shape the create answers only `{ success: true }`. A record oat could not
 * confirm is not a record: treating that acknowledgment as one put a phantom with no fields into
 * the cohort, and checks that reason about the cohort (nulls, sort) reported a correct backend.
 */

describe("recall behind the client-ids shape", () => {
	it("detects mangled payloads without reporting anything else", async () => {
		const result = await judgeDefect("STRING_PAYLOAD_MANGLED", {
			backend: "memory",
			dialect: "postgrest",
			shape: "client-ids",
			via: listening,
		})
		expect(result.error).toBeUndefined()
		expect(result.detected).toBe(true)
		expect(result.spurious.map((finding) => `${finding.check}: ${finding.summary}`)).toEqual([])
	})

	it("detects a create that ignores the client's id, with only that loss's symptoms", async () => {
		const result = await judgeDefect("CLIENT_ID_IGNORED", {
			backend: "memory",
			dialect: "postgrest",
			shape: "client-ids",
			via: listening,
		})
		expect(result.error).toBeUndefined()
		expect(result.detected).toBe(true)
		expect(result.spurious.map((finding) => `${finding.check}: ${finding.summary}`)).toEqual([])
	})
})
