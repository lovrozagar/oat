import { describe, expect, it } from "vitest"
import { decodeJwt, signJwt } from "./jwt.ts"

const SECRET = "test-secret"
const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url")

describe("signJwt", () => {
	it("signs the claims as an HS256 JWT in three base64url segments", () => {
		const token = signJwt(SECRET, { jti: "jti_1", sub: "key_alpha" })
		const [header, payload, signature] = token.split(".")
		expect(JSON.parse(Buffer.from(header as string, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" })
		expect(JSON.parse(Buffer.from(payload as string, "base64url").toString())).toEqual({
			jti: "jti_1",
			sub: "key_alpha",
		})
		expect(signature).toMatch(/^[\w-]{43}$/)
	})

	it("is deterministic for the same secret and claims, and differs by secret", () => {
		expect(signJwt(SECRET, { a: 1 })).toBe(signJwt(SECRET, { a: 1 }))
		expect(signJwt(SECRET, { a: 1 })).not.toBe(signJwt("other", { a: 1 }))
	})
})

describe("decodeJwt", () => {
	it("reads back the claims of a token it signed, as signed", () => {
		expect(decodeJwt(SECRET, signJwt(SECRET, { sub: "key_beta" }))).toEqual({
			claims: { sub: "key_beta" },
			signed: true,
		})
	})

	it("reads a token whose signature was altered, or signed with another secret, as unsigned", () => {
		const token = signJwt(SECRET, { sub: "key_beta" })
		const flipped = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`
		expect(decodeJwt(SECRET, flipped)).toEqual({ claims: { sub: "key_beta" }, signed: false })
		expect(decodeJwt(SECRET, signJwt("other", { sub: "x" }))?.signed).toBe(false)
		expect(decodeJwt(SECRET, `${token.split(".").slice(0, 2).join(".")}.`)?.signed).toBe(false)
	})

	it("reads a token of another algorithm as unsigned, whatever its signature", () => {
		const [, payload, signature] = signJwt(SECRET, { sub: "x" }).split(".")
		const none = `${segment({ alg: "none", typ: "JWT" })}.${payload}.${signature}`
		expect(decodeJwt(SECRET, none)).toEqual({ claims: { sub: "x" }, signed: false })
	})

	it("refuses what is not a JWT at all", () => {
		const claims = segment({ sub: "x" })
		for (const token of [
			"",
			"tok_alpha",
			"a.b",
			"a.b.c.d",
			`${segment({ alg: "HS256" })}.not-json.sig`,
			`${segment({ alg: "HS256" })}.${segment([1])}.sig`,
			`${segment({ alg: "HS256" })}.${segment(null)}.sig`,
			`${segment("HS256")}.${claims}.sig`,
		]) {
			expect(decodeJwt(SECRET, token)).toBeNull()
		}
	})
})
