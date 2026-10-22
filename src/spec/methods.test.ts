import { describe, expect, it } from "vitest"
import {
	BODILESS_READS,
	BODY_READS,
	IDEMPOTENT,
	MUTATING,
	PATH_ITEM_METHODS,
	READS,
	SAFE,
	SAFE_METHODS,
	UNSENDABLE,
	unsendableReason,
} from "./methods.ts"

describe("the method list", () => {
	it("names every operation field of an OAS 3.2 path item, query and trace included", () => {
		expect(PATH_ITEM_METHODS).toEqual(["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"])
	})

	it("calls GET, HEAD, OPTIONS, TRACE and QUERY safe, and adds PUT and DELETE for idempotent", () => {
		expect([...SAFE]).toEqual(["GET", "HEAD", "OPTIONS", "TRACE", "QUERY"])
		expect([...SAFE]).toEqual([...SAFE_METHODS])
		expect([...IDEMPOTENT]).toEqual(["GET", "HEAD", "OPTIONS", "TRACE", "QUERY", "PUT", "DELETE"])
	})

	it("calls every method that is not safe mutating, so QUERY and TRACE never are", () => {
		expect([...MUTATING]).toEqual(["PUT", "POST", "DELETE", "PATCH"])
		for (const method of SAFE) expect(MUTATING.has(method)).toBe(false)
	})

	it("reads a representation by GET, HEAD and QUERY; only QUERY carries its question in a body", () => {
		expect([...READS]).toEqual(["GET", "HEAD", "QUERY"])
		expect([...BODY_READS]).toEqual(["QUERY"])
		expect([...BODILESS_READS]).toEqual(["GET", "HEAD"])
	})

	it("never sends TRACE, and says why", () => {
		expect([...UNSENDABLE.keys()]).toEqual(["TRACE"])
		expect(unsendableReason("trace")).toMatch(/fetch refuses TRACE/)
		expect(unsendableReason("QUERY")).toBeNull()
	})
})
