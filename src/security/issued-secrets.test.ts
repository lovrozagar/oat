import { describe, expect, it } from "vitest"
import { issuedSecrets } from "./issued-secrets.ts"

describe("issuedSecrets", () => {
	it("finds a value under a secret key, nested or in a list, raw and as an otpauth URI carries it", () => {
		expect(issuedSecrets({ data: [{ mfa: { secret: "jbsw y3dp ehpk 3pxp==" } }] })).toEqual([
			"jbsw y3dp ehpk 3pxp==",
			"JBSWY3DPEHPK3PXP",
		])
	})

	it("takes 16 characters or more whatever they are, 12 to 15 only when not letters alone, nothing shorter", () => {
		expect(issuedSecrets({ secret: "ABCDEFGHIJKLMNOP" })).toEqual(["ABCDEFGHIJKLMNOP"])
		expect(issuedSecrets({ api_secret: "ab12cd34ef56" })).toEqual(["ab12cd34ef56"])
		expect(issuedSecrets({ password_hint: "Abcdefghijklm", token_type: "Bearer", secret: "short1" })).toEqual([])
	})

	it("leaves a value under any other key, and a body with no object in it", () => {
		expect(issuedSecrets({ name: "JBSWY3DPEHPK3PXP" })).toEqual([])
		expect(issuedSecrets("JBSWY3DPEHPK3PXP")).toEqual([])
		expect(issuedSecrets(null)).toEqual([])
	})
})
