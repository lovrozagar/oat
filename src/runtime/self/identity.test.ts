import { describe, expect, it } from "vitest"
import type { RequestOptions } from "../../client/types.ts"
import type { Answer, Responder } from "../checks/__fixtures__/harness.ts"
import { ASSERTED } from "../finding.ts"
import { type MeOptions, me, selfInput } from "./__fixtures__/me.ts"
import { runSelfIdentity } from "./identity.ts"

const SIGNUP = { properties: { handle: { type: "string" } }, required: ["handle"], type: "object" }

/* The anonymous probe is a 401; a request as the caller is up to `answer`. */
const caller =
	(answer: (method: string, path: string, options: Omit<RequestOptions, "as">) => Answer | undefined): Responder =>
	(method, path, options) =>
		options.probe === true ? { status: 401 } : answer(method, path, options)

function check(respond: Responder, document: MeOptions = {}) {
	const { input, findings, sent } = selfInput(respond, me(document))
	return { findings, result: runSelfIdentity(input), sent }
}

/* A caller whose profile keeps what it is sent. */
function stored(initial: Record<string, unknown>): Responder {
	let profile = { ...initial }
	return caller((method, _path, options) => {
		if (method === "PATCH" || method === "POST") profile = { ...profile, ...(options.body as Record<string, unknown>) }
		return { body: profile, status: method === "POST" ? 201 : 200 }
	})
}

describe("runSelfIdentity", () => {
	it("has nothing to probe without a read or an update, or on a route that needs an id", async () => {
		expect(await check(() => undefined, { create: SIGNUP, read: false, update: false }).result).toEqual({
			kind: "unresolved",
			reason: "no read or update",
		})
		expect(await check(() => undefined, { read: "/me/{slot}" }).result).toEqual({
			kind: "unresolved",
			reason: "me.get needs a path id",
		})
	})

	it("flags a caller route that answers without a token", async () => {
		const { result, findings } = check(() => ({ status: 200 }))
		expect(await result).toEqual({ kind: "finding", verdict: "SECURITY" })
		expect(findings.findings[0]?.operations).toEqual(["me.get", "me.update"])
	})

	it("judges the update alone when there is no read", async () => {
		const { result, sent } = check(
			caller(() => ({ status: 204 })),
			{ read: false },
		)
		expect(await result).toBe(ASSERTED)
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["PATCH /me", "PATCH /me"])
		expect(sent[1]?.options.body).toEqual({ note: "Oat" })
	})

	it("writes a field, reads it back, and puts the old value back", async () => {
		const { result, sent } = check(stored({ display_name: "Ada", id: "u1" }))
		expect(await result).toBe(ASSERTED)
		expect(sent.slice(1).map((request) => `${request.method} ${JSON.stringify(request.options.body ?? null)}`)).toEqual(
			["GET null", 'PATCH {"display_name":"Oat"}', "GET null", 'PATCH {"display_name":"Ada"}'],
		)
	})

	it("leaves a field it found no value for as the update left it", async () => {
		const { result, sent } = check(stored({ id: "u1" }))
		expect(await result).toBe(ASSERTED)
		expect(sent.filter((request) => request.method === "PATCH")).toHaveLength(1)
	})
})

describe("runSelfIdentity's anonymous probe", () => {
	it("stands down when the document declares no security, since nothing says the route needs a token", async () => {
		const { findings, input, sent } = selfInput(() => ({ status: 200 }), me({ security: false }))
		expect(await runSelfIdentity(input)).toEqual({
			kind: "unresolved",
			reason: "the document declares no security; add an overlay",
		})
		expect(sent).toEqual([])
		expect(findings.findings).toEqual([])
	})

	it("probes anonymously, then acts as the caller", async () => {
		const { result, sent } = check(stored({ display_name: "Ada", id: "u1" }))
		expect(await result).toBe(ASSERTED)
		expect(sent[0]?.options).toMatchObject({ as: { anonymous: true }, probe: true })
		expect(sent.slice(1).map((request) => request.options.as)).toEqual(
			Array.from({ length: 4 }, () => ({ principal: "alpha" })),
		)
		expect(sent.slice(1).every((request) => request.options.probe === undefined)).toBe(true)
	})
})

describe("runSelfIdentity with a create and more reads", () => {
	it("creates the caller first, reads every read, and asks each action", async () => {
		const { result, sent } = check(stored({ id: "u1" }), {
			action: ["handle"],
			create: SIGNUP,
			secondRead: "/me/settings",
		})
		expect(await result).toBe(ASSERTED)
		expect(sent.slice(1, 5).map((request) => `${request.method} ${request.path}`)).toEqual([
			"POST /me",
			"GET /me",
			"GET /me/settings",
			"GET /me/lookup",
		])
	})

	it("ends on a create that failed, a read that needs an id, or a refused read", async () => {
		expect(
			await check(
				caller(() => ({ status: 500 })),
				{ create: SIGNUP },
			).result,
		).toEqual({
			kind: "finding",
			verdict: "BACKEND_BUG",
		})
		expect(await check(stored({}), { secondRead: "/me/items/{item_id}" }).result).toEqual({
			kind: "unresolved",
			reason: "me.settings needs a path id",
		})
		expect(await check(caller(() => ({ status: 404 }))).result).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
	})

	it("ends when the read does not show the create, or an action answers wrongly", async () => {
		const forgetful = caller((method) =>
			method === "POST" ? { status: 201 } : { body: { handle: "someone" }, status: 200 },
		)
		const missed = check(forgetful, { create: SIGNUP })
		expect(await missed.result).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(missed.findings.findings[0]?.summary).toBe("the create did not show up on the next read")
		const confused = caller((method, path, options) => {
			if (path === "/me/lookup") return { body: { handle: "other" }, status: 200 }
			return method === "POST"
				? { status: 201 }
				: { body: options.body ?? { handle: "Quarterly Report 0" }, status: 200 }
		})
		const acted = check(confused, { action: ["handle"], create: SIGNUP })
		expect(await acted.result).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(acted.findings.findings[0]?.summary).toBe("the caller query answered about a different value")
	})
})

describe("runSelfIdentity's update", () => {
	it("ends without an update to send", async () => {
		expect(await check(stored({}), { update: false }).result).toBe(ASSERTED)
	})

	it("reports an update refused, or one the next read does not show", async () => {
		const refused = caller((method) => (method === "PATCH" ? { status: 422 } : { body: {}, status: 200 }))
		expect(await check(refused).result).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const ignored = caller(() => ({ body: { display_name: "Ada" }, status: 200 }))
		const lost = check(ignored)
		expect(await lost.result).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(lost.findings.findings[0]?.summary).toBe("an update to the caller did not stick")
	})
})
