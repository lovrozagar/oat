import { describe, expect, it } from "vitest"
import type { Finding } from "./finding.ts"
import { findingKey, normalizeDetail } from "./finding-key.ts"

/*
 * The same defect found by two runs must be recognisable as the same: a baseline matches it and a
 * diff calls it persisting. Its detail carries run-specific values — record ids, UUIDs, ports,
 * timestamps — that change every run while the defect does not.
 */

const finding = (overrides: Partial<Finding> = {}): Finding => ({
	check: "list.read-after-write",
	detail:
		"created tbl_8f3k2 (a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d) at 2026-10-15T21:03:04.123Z on " +
		"http://127.0.0.1:53211/v1/tables, listed 1760562184123 ms later: missing",
	entity: "table",
	evidence: [],
	operations: ["table.list", "table.create"],
	summary: "a created record is missing from the list",
	verdict: "BACKEND_BUG",
	...overrides,
})

describe("findingKey", () => {
	it("is the same across runs that differ only in run-specific values", () => {
		const other = finding({
			detail:
				"created tbl_q9z0x (0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f) at 2026-10-16T08:00:59.001Z on " +
				"http://127.0.0.1:40001/v1/tables, listed 1760600000000 ms later: missing",
			operations: ["table.create", "table.list"],
		})
		expect(findingKey(other)).toBe(findingKey(finding()))
	})

	it("ignores a reworded summary", () => {
		expect(findingKey(finding({ summary: "the list lost a record" }))).toBe(findingKey(finding()))
	})

	it("tells apart another check, entity, operation or detail", () => {
		const base = findingKey(finding())
		expect(findingKey(finding({ check: "list.total-matches" }))).not.toBe(base)
		expect(findingKey(finding({ entity: "row" }))).not.toBe(base)
		expect(findingKey(finding({ operations: ["table.list"] }))).not.toBe(base)
		expect(findingKey(finding({ detail: "created tbl_8f3k2: duplicated" }))).not.toBe(base)
	})
})

describe("normalizeDetail", () => {
	it("keeps small numbers and words, which carry the meaning", () => {
		expect(normalizeDetail("returned 3 of 5 records, expected 404")).toBe("returned 3 of 5 records, expected 404")
	})
})
