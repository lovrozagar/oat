import { describe, expect, it } from "vitest"
import { UsageError } from "../../errors/usage-error.ts"
import { ScopeError } from "./scope-error.ts"

describe("ScopeError", () => {
	it("is a usage error named for scope", () => {
		const error = new ScopeError("oat: --ops matches nothing")
		expect(error).toBeInstanceOf(UsageError)
		expect(error.name).toBe("ScopeError")
		expect(error.message).toBe("oat: --ops matches nothing")
	})
})
