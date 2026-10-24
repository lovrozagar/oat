import { describe, expect, it } from "vitest"
import { api } from "../__fixtures__/api.ts"

describe("the TOTP setup route", () => {
	it("answers a fresh base32 secret, its otpauth URI and a QR image, under the totp-setup shape", async () => {
		const { call } = await api({ shape: "totp-setup" })
		const first = (await call("POST", "/v1/me/2fa")).body as Record<string, string>
		const second = (await call("POST", "/v1/me/2fa")).body as Record<string, string>
		expect(first["secret"]).toMatch(/^[A-Z2-7]{32}$/)
		expect(first["otpauth_uri"]).toMatch(
			new RegExp(`^otpauth://totp/oat-reference:[^?]+\\?secret=${first["secret"]}&issuer=oat-reference$`),
		)
		expect(first["qr_code"]).toMatch(/^data:image\/png;base64,/)
		expect(second["secret"]).not.toBe(first["secret"])
	})

	it("is not there without the shape, and refuses an anonymous caller", async () => {
		expect((await (await api()).call("POST", "/v1/me/2fa")).status).toBe(404)
		expect((await (await api({ shape: "totp-setup" })).call("POST", "/v1/me/2fa", { token: null })).status).toBe(401)
	})
})
