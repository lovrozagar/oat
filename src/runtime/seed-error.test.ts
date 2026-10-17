import { describe, expect, it } from "vitest"
import { SeedError } from "./seed-error.ts"

describe("SeedError", () => {
	it("carries the culprit, status and operation of the failed request", () => {
		const error = new SeedError("table_id", "create failed", 409, "table.create")
		expect(error).toBeInstanceOf(Error)
		expect([error.message, error.culprit, error.status, error.operationId]).toEqual([
			"create failed",
			"table_id",
			409,
			"table.create",
		])
		expect(error.exchange).toBeUndefined()
	})
})
