import { describe, expect, it } from "vitest"
import { MissingValueError } from "./missing-value.ts"

describe("MissingValueError", () => {
	it("says where the value was missing", () => {
		const error = new MissingValueError("the path parameter {table_id}")
		expect([error.name, error.where, error.message]).toEqual([
			"MissingValueError",
			"the path parameter {table_id}",
			"oat had no value for the path parameter {table_id}",
		])
	})
})
