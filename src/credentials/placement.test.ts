import { describe, expect, it } from "vitest"
import type { SecurityScheme } from "../spec/security/schemes.ts"
import { sendsFor, UnsupportedSchemeError } from "./placement.ts"

const bearer: SecurityScheme = { deprecated: false, kind: "bearer", name: "jwt" }
const apiKey = (location: "header" | "query" | "cookie", param: string): SecurityScheme => ({
	deprecated: false,
	in: location,
	kind: "apiKey",
	name: "key",
	param,
})

describe("sendsFor", () => {
	it("puts a bearer credential in Authorization and names it secret", () => {
		expect(sendsFor(bearer, {}, "t0k")).toEqual({
			secrets: { cookies: [], headers: ["Authorization"], query: [], values: ["t0k"] },
			sends: { cookies: {}, headers: { Authorization: "Bearer t0k" }, query: {} },
		})
	})

	it("replaces only the template with `format`", () => {
		const { sends } = sendsFor(apiKey("header", "Authorization"), { format: "ApiKey {credential}" }, "k1")
		expect(sends.headers).toEqual({ Authorization: "ApiKey k1" })
	})

	it("places an apiKey in the query or a cookie, by the scheme", () => {
		expect(sendsFor(apiKey("query", "api_key"), {}, "q").sends.query).toEqual({ api_key: "q" })
		const cookie = sendsFor(apiKey("cookie", "sid"), {}, "c")
		expect([cookie.sends.cookies, cookie.secrets.cookies]).toEqual([{ sid: "c" }, ["sid"]])
	})
})

describe("sendsFor: extra places, basic and unsupported schemes", () => {
	it("adds extra placements, with `{credential}` as their default template", () => {
		const recipe = {
			placements: [
				{ in: "query" as const, name: "token" },
				{ in: "cookie" as const, name: "session", template: "s={credential}" },
				{ in: "header" as const, name: "X-Token" },
			],
		}
		expect(sendsFor(bearer, recipe, "v")).toEqual({
			secrets: {
				cookies: ["session"],
				headers: ["Authorization", "X-Token"],
				query: ["token"],
				values: ["v"],
			},
			sends: {
				cookies: { session: "s=v" },
				headers: { Authorization: "Bearer v", "X-Token": "v" },
				query: { token: "v" },
			},
		})
	})

	it("base64s a basic pair, and keeps the pair, its encoding and the bare password secret", () => {
		const basic: SecurityScheme = { deprecated: false, kind: "basic", name: "basic" }
		const encoded = Buffer.from("ann:p:w").toString("base64")
		expect(sendsFor(basic, {}, "ann:").secrets.values).toEqual(["ann:", Buffer.from("ann:").toString("base64")])
		expect(sendsFor(basic, {}, "token").secrets.values).toEqual(["token", Buffer.from("token").toString("base64")])
		expect(sendsFor(basic, {}, "ann:p:w")).toEqual({
			secrets: { cookies: [], headers: ["Authorization"], query: [], values: ["ann:p:w", encoded, "p:w"] },
			sends: { cookies: {}, headers: { Authorization: `Basic ${encoded}` }, query: {} },
		})
	})

	it("refuses a scheme oat cannot send, with the reason", () => {
		const digest: SecurityScheme = { deprecated: false, kind: "unsupported", name: "d", unsupported: "http digest" }
		const thrown = (() => {
			try {
				return sendsFor(digest, {}, "x")
			} catch (error) {
				return error
			}
		})()
		expect(thrown).toBeInstanceOf(UnsupportedSchemeError)
		expect(thrown).toMatchObject({
			message: 'oat cannot send the "d" scheme: http digest',
			reason: "http digest",
			scheme: "d",
		})
	})
})
