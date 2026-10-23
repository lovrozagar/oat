import { describe, expect, it } from "vitest"
import { isRaw, isRawUnion, isRecord } from "./raw.ts"

/* An input oat has not checked yet is a plain object, or it is not read by key at all. */

describe("the raw guards", () => {
	it("take a plain object, and nothing else, as one to read by key", () => {
		for (const guard of [isRaw<{ a: string }>, isRawUnion<{ a: string } | { b: number }>, isRecord]) {
			expect(guard({ a: 1 })).toBe(true)
			expect([null, undefined, "a", 1, [1]].map((value) => guard(value))).toEqual([false, false, false, false, false])
		}
	})
})
