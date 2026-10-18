import { describe, expect, it } from "vitest"
import { RunCredentials } from "./credentials.ts"

const bound = (token: string) => ({
	headers: () => ({ authorization: `Bearer ${token}` }),
	matches: (headers: Readonly<Record<string, string>>) => headers.authorization === `Bearer ${token}`,
	refreshIfStale: async () => undefined,
})

describe("RunCredentials", () => {
	it("finds the bound credential a request's headers carry, and none for others", () => {
		const credentials = new RunCredentials()
		const alpha = bound("a")
		credentials.bind(alpha)
		credentials.bind(bound("b"))
		expect(credentials.credentialFor({ headers: { authorization: "Bearer a" } })).toBe(alpha)
		expect(credentials.credentialFor({ headers: { authorization: "Bearer z" }, operationId: "x" })).toBeUndefined()
	})

	it("names no principal until the run names its senders", () => {
		const credentials = new RunCredentials()
		expect(credentials.principalOf({ authorization: "Bearer a" })).toBeUndefined()
		credentials.nameSenders((headers) => (headers.authorization === "Bearer a" ? "alpha" : undefined))
		expect(credentials.principalOf({ authorization: "Bearer a" })).toBe("alpha")
	})
})
