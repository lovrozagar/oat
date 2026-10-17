import { describe, expect, it } from "vitest"
import { UsageError } from "./usage-error.ts"

describe("UsageError", () => {
	it("is an Error named for what it is", () => {
		const error = new UsageError("allow names nothing")
		expect(error).toBeInstanceOf(Error)
		expect([error.name, error.message]).toEqual(["UsageError", "allow names nothing"])
	})
})
