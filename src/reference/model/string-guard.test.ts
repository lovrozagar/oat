import { describe, expect, it } from "vitest"
import { guardStrings, PHONE_PATTERN, STRING_GUARD } from "./string-guard.ts"
import type { FieldDef } from "./types.ts"

describe("guardStrings", () => {
	it("adds the guard after a written string's own patterns, and leaves every other field alone", () => {
		const fields: FieldDef[] = [
			{ name: "name", type: "string" },
			{ name: "phone", patterns: [PHONE_PATTERN], type: "string" },
			{ generated: true, name: "id", type: "string" },
			{ name: "count", type: "integer" },
		]
		expect(guardStrings(fields)).toEqual([
			{ name: "name", patterns: [STRING_GUARD], type: "string" },
			{ name: "phone", patterns: [PHONE_PATTERN, STRING_GUARD], type: "string" },
			{ generated: true, name: "id", type: "string" },
			{ name: "count", type: "integer" },
		])
	})
})
