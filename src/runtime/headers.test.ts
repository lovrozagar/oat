import { describe, expect, it } from "vitest"
import { headerValue, presentHeader } from "./headers.ts"

describe("header lookup", () => {
	const headers = { "Content-Type": "application/json", "X-Empty": "  " }

	it("matches a name in any case", () => {
		expect(headerValue(headers, "content-type")).toBe("application/json")
		expect(headerValue(headers, "retry-after")).toBeUndefined()
	})

	it("treats a header sent blank as absent", () => {
		expect(presentHeader(headers, "CONTENT-TYPE")).toBe("application/json")
		expect(presentHeader(headers, "x-empty")).toBeUndefined()
		expect(presentHeader(headers, "retry-after")).toBeUndefined()
	})
})
