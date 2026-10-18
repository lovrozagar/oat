import { describe, expect, it, vi } from "vitest"
import { MissingValueError } from "../errors/missing-value.ts"
import { Fence } from "../runtime/fence.ts"
import { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import { json, transport } from "./__fixtures__/transport.ts"
import { BASE, wireOf } from "./__fixtures__/wire.ts"
import { prepare, sendAttempt } from "./request.ts"
import type { RequestStart } from "./types.ts"

const resolver = () => ({ entity: "row", operationId: "row.list", requiredQuery: { tenant: "t1" }, template: "/rows" })

describe("prepare", () => {
	it("resolves the operation below the base and adds its required query", () => {
		const wire = wireOf(
			transport(() => json({})),
			{ operationResolver: resolver },
		)
		const request = prepare(wire, "get", "/rows", { query: { page: 2 } })
		expect(request).toMatchObject({ method: "GET", operationId: "row.list", relative: "/rows" })
		expect(request.url.toString()).toBe(`${BASE}/rows?page=2&tenant=t1`)
	})

	it("resolves no operation for an absolute URL, and names the caller's operation over the resolved one", () => {
		const wire = wireOf(
			transport(() => json({})),
			{ operationResolver: resolver },
		)
		expect(prepare(wire, "GET", "http://cdn.test/f", {})).toMatchObject({ operationId: undefined, resolved: null })
		expect(prepare(wire, "GET", "/rows", { operationId: "mine" }).operationId).toBe("mine")
		expect(prepare(wireOf(transport(() => json({}))), "GET", "/rows", {}).resolved).toBeNull()
	})

	it("refuses to send a value oat did not have", () => {
		const wire = wireOf(transport(() => json({})))
		expect(() => prepare(wire, "DELETE", "/rows/undefined", {})).toThrow(MissingValueError)
	})

	it("reads the caller's headers afresh, and finds their credential unless refresh is skipped", () => {
		let token = "a"
		const credential = { headers: () => ({ authorization: `Bearer ${token}` }), refreshIfStale: async () => undefined }
		const asked: unknown[] = []
		const credentials = {
			credentialFor: (request: unknown) => (asked.push(request), credential),
			principalOf: () => undefined,
		}
		const wire = wireOf(
			transport(() => json({})),
			{ credentials, operationResolver: resolver },
		)
		const request = prepare(wire, "GET", "/rows", { headers: () => ({ authorization: `Bearer ${token}` }) })
		token = "b"
		expect(request.callerHeaders()).toEqual({ authorization: "Bearer b" })
		expect(request.credential({ x: "1" })).toBe(credential)
		expect(asked).toEqual([{ headers: { x: "1" }, operationId: "row.list" }])
		expect(prepare(wire, "GET", "/x", { headers: { a: "1" } }).callerHeaders()).toEqual({ a: "1" })
		expect(prepare(wire, "GET", "/x", {}).callerHeaders()).toEqual({})
		expect(prepare(wire, "GET", "/x", { skipAuthRefresh: true }).credential({})).toBeUndefined()
		const bare = wireOf(
			transport(() => json({})),
			{ credentials },
		)
		prepare(bare, "GET", "/x", {}).credential({})
		expect(asked.at(-1)).toEqual({ headers: {} })
	})
})

describe("sendAttempt", () => {
	it("sends globals, then the hook's, then the caller's, then the credential, with the body's type", async () => {
		const wire = transport(() => json({}))
		const hooked: unknown[] = []
		const live = {
			headers: () => ({ authorization: "Bearer live", "x-key": "k" }),
			refreshIfStale: async () => undefined,
		}
		const ctx = wireOf(wire, {
			credentials: { credentialFor: () => live, principalOf: () => "alpha" },
			headers: { g: "1", h: "global" },
			resolveHeaders: async (request) => (hooked.push(request), { h: "hook", i: "hook" }),
		})
		const options = { body: { n: 1 }, headers: { authorization: "Bearer old", i: "caller" }, operationId: "row.create" }
		await sendAttempt(prepare(ctx, "POST", "/rows", options), 0, ctx)
		expect(wire.sent[0]?.headers).toEqual({
			authorization: "Bearer live",
			"content-type": "application/json",
			g: "1",
			h: "hook",
			i: "caller",
			"x-key": "k",
		})
		await sendAttempt(prepare(ctx, "GET", "/rows", {}), 0, ctx)
		expect(hooked).toEqual([
			{ method: "POST", operationId: "row.create", url: `${BASE}/rows` },
			{ method: "GET", url: `${BASE}/rows` },
		])
		expect(wire.sent[0]?.body).toBe('{"n":1}')
	})

	it("asks the fence first, and sends nothing it refuses", async () => {
		const wire = transport(() => json({}))
		const fence = new Fence(() => ({ allow: false, reason: "read-only run" }))
		const ctx = wireOf(wire, { fence })
		await expect(sendAttempt(prepare(ctx, "DELETE", "/rows/1", {}), 0, ctx)).rejects.toThrow(/read-only run/)
		expect(wire.sent).toEqual([])
		expect(fence.fenced).toMatchObject([{ method: "DELETE", phase: "request" }])
	})
})

describe("sendAttempt on the wire", () => {
	it("paces by the route's rule, the implicit one after a 429, and the origin's ceiling alone", async () => {
		const tagged = {
			category: "writes",
			rps: 1000,
			source: "tag" as const,
			test: (method: string) => method === "POST",
		}
		const limiter = new RateLimiter([tagged], { maxRps: 1000 })
		const ctx = wireOf(
			transport(() => json({})),
			{ rateLimiter: limiter },
		)
		const write = await sendAttempt(prepare(ctx, "POST", "/rows", { body: {} }), 0, ctx)
		expect(write).toMatchObject({ rateLimitCategory: "writes", rateLimitHadRoom: true, rateLimitSource: "tag" })
		const read = await sendAttempt(prepare(ctx, "GET", "/rows", {}), 0, ctx)
		expect(read.rateLimitCategory).toBeUndefined()
		limiter.noteBackoff({ method: "DELETE", pathname: "/rows/1" }, 0)
		const cooled = await sendAttempt(prepare(ctx, "DELETE", "/rows/1", {}), 0, ctx)
		expect(cooled).toMatchObject({ rateLimitHadRoom: true, rateLimitSource: "implicit" })
	})

	it("runs the hooks around the wire, and times each attempt out when asked", async () => {
		const wire = transport(() => json({}))
		const seen: string[] = []
		const hooks = {
			end: (probe: RequestStart) => seen.push(`end ${probe.method} ${probe.requestBytes > 0}`),
			start: (probe: RequestStart) => seen.push(`start ${probe.url}`),
		}
		const ctx = wireOf(wire, { httpHooks: hooks, network: { fetchImpl: wire.fetch, requestTimeoutMs: 5_000 } })
		await sendAttempt(prepare(ctx, "GET", "/rows", {}), 0, ctx)
		expect(seen).toEqual([`start ${BASE}/rows`, "end GET true"])
		expect(wire.sent[0]?.signal).toBe(true)
		const bare = wireOf(wire, { httpHooks: {} })
		await sendAttempt(prepare(bare, "GET", "/rows", {}), 0, bare)
		expect(wire.sent[1]?.signal).toBe(false)
	})
})

describe("sendAttempt redirects and transport", () => {
	it("hands redirects to the caller or the operation, or follows them through the jar", async () => {
		const wire = transport((request) =>
			request.url.endsWith("/a") ? new Response(null, { headers: { location: "/v1/b" }, status: 302 }) : json({}),
		)
		const ctx = wireOf(wire)
		expect((await sendAttempt(prepare(ctx, "GET", "/a", { redirect: "manual" }), 0, ctx)).status).toBe(302)
		const resolving = wireOf(wire, { operationResolver: () => ({ operationId: "a", redirects: true, template: "/a" }) })
		expect((await sendAttempt(prepare(resolving, "GET", "/a", {}), 0, resolving)).status).toBe(302)
		const followed = await sendAttempt(prepare(ctx, "GET", "/a", { redirect: "follow" }), 0, ctx)
		expect(followed).toMatchObject({ finalUrl: `${BASE}/b`, status: 200 })
		await sendAttempt(prepare(ctx, "GET", "/a", {}), 0, ctx)
		expect(wire.sent.map((request) => request.redirect)).toEqual(["manual", "manual", "manual", "manual", undefined])
	})

	it("uses the global fetch when no transport is given", async () => {
		const wire = transport(() => json({ global: true }))
		vi.stubGlobal("fetch", wire.fetch)
		try {
			const ctx = wireOf(wire, { network: undefined })
			expect((await sendAttempt(prepare(ctx, "GET", "/rows", {}), 0, ctx)).responseBody).toEqual({ global: true })
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
