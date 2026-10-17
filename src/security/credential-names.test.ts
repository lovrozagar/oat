import { describe, expect, it } from "vitest"
import { CREDENTIAL_HEADERS, isSecretHeaderName, isSecretJsonKey } from "./credential-names.ts"

describe("credential names", () => {
	it("knows the credential headers, any case", () => {
		expect([...CREDENTIAL_HEADERS]).toContain("authorization")
		expect(isSecretHeaderName("Authorization")).toBe(true)
		expect(isSecretHeaderName("set-cookie")).toBe(true)
		expect(isSecretHeaderName("X-Service-Token")).toBe(true)
		expect(isSecretHeaderName("accept")).toBe(false)
		expect(isSecretHeaderName("x-request-id")).toBe(false)
	})

	it("matches secret keys by family across snake and camel case", () => {
		const secret = ["refreshToken", "refresh_token", "api-key", "password", "sessionId"]
		expect(secret.map(isSecretJsonKey)).toEqual([true, true, true, true, true])
		expect(["total", "tokenizer", "name"].map(isSecretJsonKey)).toEqual([false, false, false])
	})
})
