import { describe, expect, it } from "vitest"
import { ANON, SELF, Sender, principalIdentity, sessionIdentity } from "./sender.ts"
import type { OpMap, StepTypes } from "./types.ts"

type Loose = Sender<OpMap, StepTypes>
const self: Loose = new Sender(SELF)
const anon: Loose = new Sender(ANON)
/* The config says how a session is sent; this one is a bearer token, as Anyrow's tester sends it. */
const user: Loose = new Sender(sessionIdentity({ authorization: "Bearer {credential}" }))
const beta: Loose = new Sender(principalIdentity("beta"))

describe("Sender identities", () => {
	it("sends the principal's own call with no identity keys", () => {
		expect(self.call("table.export", { query: { format: "csv" } }).toStep()).toStrictEqual({
			operationId: "table.export",
			query: { format: "csv" },
		})
	})

	it("sends no credential when anonymous", () => {
		expect(anon.call("auth.refreshToken", { body: { refresh_token: "{refreshToken}" } }).toStep()).toStrictEqual({
			anonymous: true,
			body: { refresh_token: "{refreshToken}" },
			operationId: "auth.refreshToken",
		})
	})

	it("sends a session held in the scope with the headers the config gave it, as the tester's as(name) spread does", () => {
		expect(user.call("auth.deleteAccount").toStep()).toStrictEqual({
			anonymous: true,
			headers: { authorization: "Bearer {credential}" },
			operationId: "auth.deleteAccount",
		})
	})

	it("sends as another config principal", () => {
		expect(beta.call("org.acceptInvite").toStep()).toStrictEqual({ operationId: "org.acceptInvite", principal: "beta" })
	})
})

describe("Sender calls", () => {
	it("merges call headers over the session's, the call winning per key", () => {
		const step = user.call("x.y", { headers: { authorization: "Bearer {other}", cookie: "a=1" } }).toStep()
		expect(step.headers).toStrictEqual({ authorization: "Bearer {other}", cookie: "a=1" })
		expect(self.call("x.y", { headers: { cookie: "a=1" } }).toStep().headers).toStrictEqual({ cookie: "a=1" })
	})

	it("copies every init part it is given and none it is not", () => {
		const bytes = Uint8Array.of(1, 2)
		const step = self
			.call("cdn.upload", { bind: { wildcard: "u/{userId}/a.webp" }, body: bytes, mediaType: "image/webp" })
			.toStep()
		expect(step).toStrictEqual({
			bind: { wildcard: "u/{userId}/a.webp" },
			body: bytes,
			mediaType: "image/webp",
			operationId: "cdn.upload",
		})
		const loose = { body: undefined, query: { a: "1" } } as unknown as Record<string, never>
		expect(Object.keys(self.call("x.y", loose).toStep())).toEqual(["query", "operationId"])
	})

	it("sends every step of a sender put on an origin to that origin", () => {
		const cdn = user.on("cdn")
		expect(cdn.call("cdn.upload").toStep()).toStrictEqual({
			anonymous: true,
			headers: { authorization: "Bearer {credential}" },
			operationId: "cdn.upload",
			origin: "cdn",
		})
		expect(self.on("cdn").call("cdn.head").toStep()).toStrictEqual({ operationId: "cdn.head", origin: "cdn" })
	})
})

describe("Sender refusals and raw requests", () => {
	it("writes a refusal as the status and the error key the tester's refusedWith wrote", () => {
		const step = user
			.refused("auth.requestEmailChange", {
				body: { new_email: "x@anyrow.ai" },
				key: "account_reauth_required",
				status: 403,
			})
			.toStep()
		expect(step).toStrictEqual({
			anonymous: true,
			assert: { equals: "account_reauth_required", from: "$.error_key" },
			body: { new_email: "x@anyrow.ai" },
			expect: [403],
			headers: { authorization: "Bearer {credential}" },
			operationId: "auth.requestEmailChange",
		})
	})

	it("sends a raw request with its method, path and redirect policy", () => {
		const step = anon.request("GET", "{verifyLink}", { headers: { cookie: "s=1" }, redirect: "manual" }).toStep()
		expect(step).toStrictEqual({
			anonymous: true,
			headers: { cookie: "s=1" },
			method: "GET",
			path: "{verifyLink}",
			redirect: "manual",
		})
		expect(self.request("POST", "/v1/x").toStep()).toStrictEqual({ method: "POST", path: "/v1/x" })
	})
})
