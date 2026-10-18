import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { jwt } from "../scenario/__fixtures__/stage.ts"
import { computeExpiry } from "./expiry.ts"

beforeEach(() => {
	vi.useFakeTimers({ now: 1_000 })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("computeExpiry", () => {
	it("prefers the lifetime the answer states, in seconds", () => {
		expect(computeExpiry({ expiresInFrom: "$.expires_in" }, { expires_in: 60 }, jwt({ exp: 5 }))).toBe(61_000)
	})

	it("falls back to the token's own `exp` when the answer states none", () => {
		expect(computeExpiry({ expiresInFrom: "$.expires_in" }, { expires_in: "60" }, jwt({ exp: 5 }))).toBe(5_000)
		expect(computeExpiry({ assumeTtlMs: 9 }, undefined, jwt({ exp: 5 }))).toBe(5_000)
	})

	it("then to the configured lifetime, then to none", () => {
		expect(computeExpiry({ assumeTtlMs: 9 }, {}, "opaque")).toBe(1_009)
		expect(computeExpiry({}, {}, "opaque")).toBeNull()
	})
})
