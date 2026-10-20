import { describe, expect, it } from "vitest"
import { keycloak, anyrow } from "../spec/security/__fixtures__/documents.ts"
import { modelOf, op } from "./checks/__fixtures__/harness.ts"
import { noSecurityReason } from "./no-security.ts"

describe("noSecurityReason", () => {
	it("names the overlay when the document declares no security, so nothing says a token is needed", () => {
		expect(noSecurityReason(op(modelOf(keycloak), "realms.list"))).toBe(
			"the document declares no security; add an overlay",
		)
	})

	it("is undefined when the operation or the document declares security, even an anonymous one", () => {
		const model = modelOf(anyrow)
		expect(noSecurityReason(op(model, "me.get"))).toBeUndefined()
		expect(noSecurityReason(op(model, "auth.login"))).toBeUndefined()
	})
})
