import { describe, expect, it } from "vitest"
import { nonceNumber } from "./nonce.ts"

describe("nonceNumber", () => {
	it("folds a nonce into a stable non-negative number", () => {
		expect(nonceNumber("")).toBe(0)
		expect(nonceNumber("a")).toBe(97)
		expect(nonceNumber("ab")).toBe(97 * 31 + 98)
		expect(nonceNumber("x".repeat(64))).toBeGreaterThanOrEqual(0)
	})
})
