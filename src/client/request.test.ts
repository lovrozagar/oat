import { describe, expect, it, vi } from "vitest"
import { MissingValueError } from "../errors/missing-value.ts"
import { NetworkError } from "../errors/network.ts"
import type { Exchange } from "../runtime/exchange.ts"
import { Fence } from "../runtime/fence.ts"
import { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import { json, refused, transport } from "./__fixtures__/transport.ts"
import { fixedSource, sendingHeaders } from "./__fixtures__/source.ts"
import { BASE, wireOf } from "./__fixtures__/wire.ts"
import { prepare, sendAttempt } from "./request.ts"
import type { Actor } from "./credential-source.ts"
import type { RequestStart } from "./types.ts"

const ANON: Actor = { anonymous: true }

const resolver = () => ({ entity: "row", operationId: "row.list", requiredQuery: { tenant: "t1" }, template: "/rows" })

describe("prepare", () => {
	it("resolves the operation below the base and adds its required query", () => {
		const wire = wireOf(
			transport(() => json({})),
			{ operationResolver: resolver },
		)
		const request = prepare(wire, "get", "/rows", { as: ANON, query: { page: 2 } })
		expect(request).toMatchObject({ method: "GET", operationId: "row.list", relative: "/rows" })
		expect(request.url.toString()).toBe(`${BASE}/rows?page=2&tenant=t1`)
	})

	it("resolves a same-origin absolute URL like a path, a foreign one never, and names the caller's operation over the resolved one", () => {
		const wire = wireOf(
			transport(() => json({})),
			{ operationResolver: resolver },
		)
		expect(prepare(wire, "GET", "http://cdn.test/f", { as: ANON })).toMatchObject({
			operationId: undefined,
			resolved: null,
		})
		const next = prepare(wire, "GET", `${BASE}/rows?page=2`, { as: ANON })
		expect(next).toMatchObject({ operationId: "row.list", relative: "/rows" })
		expect(next.url.toString()).toBe(`${BASE}/rows?page=2&tenant=t1`)
		expect(prepare(wire, "GET", "/rows", { as: ANON, operationId: "mine" }).operationId).toBe("mine")
		expect(prepare(wireOf(transport(() => json({}))), "GET", "/rows", { as: ANON }).resolved).toBeNull()
	})

	it("refuses to send a value oat did not have", () => {
		const wire = wireOf(transport(() => json({})))
		expect(() => prepare(wire, "DELETE", "/rows/undefined", { as: ANON })).toThrow(MissingValueError)
	})

	it("reads the caller's headers afresh, and keeps apart the query the caller set", () => {
		let token = "a"
		const wire = wireOf(
			transport(() => json({})),
			{ operationResolver: resolver },
		)
		const request = prepare(wire, "GET", "/rows?q=1", { as: ANON, headers: () => ({ "x-trace": token }) })
		token = "b"
		expect(request.callerHeaders()).toEqual({ "x-trace": "b" })
		expect([...request.callerQuery]).toEqual(["q"])
		expect(request.url.searchParams.get("tenant")).toBe("t1")
		expect(prepare(wire, "GET", "/x", { as: ANON, headers: { a: "1" } }).callerHeaders()).toEqual({ a: "1" })
		expect(prepare(wire, "GET", "/x", { as: ANON }).callerHeaders()).toEqual({})
	})
})

describe("prepare: the actor", () => {
	it("asks the source for the actor, the operation and whether it is a probe", async () => {
		const source = fixedSource({ kind: "anonymous" })
		const ctx = wireOf(
			transport(() => json({})),
			{ credentials: source, operationResolver: resolver },
		)
		await sendAttempt(prepare(ctx, "GET", "/rows", { as: { principal: "alpha" }, probe: true }), 0, ctx)
		expect(source.asked).toEqual([
			{ actor: { principal: "alpha" }, operationId: "row.list", probe: true, route: "GET /rows" },
		])
	})

	it("names a foreign URL by its origin and path, and follows one from a response as nobody", async () => {
		const source = fixedSource({ kind: "anonymous" })
		const ctx = wireOf(
			transport(() => json({})),
			{ credentials: source, operationResolver: resolver },
		)
		const via = { principal: "alpha", via: { schemes: ["jwt"] } as Exchange }
		const signed = "http://storage.test/b/f?signature=s3cr3t"
		await sendAttempt(prepare(ctx, "GET", signed, { as: { principal: "alpha" } }), 0, ctx)
		await sendAttempt(prepare(ctx, "GET", signed, { as: via }), 0, ctx)
		await sendAttempt(prepare(ctx, "GET", `${BASE}/jobs/1`, { as: via }), 0, ctx)
		expect(source.asked).toEqual([
			{ actor: { principal: "alpha" }, probe: false, route: "GET http://storage.test/b/f" },
			{ actor: { anonymous: true }, probe: false, route: "GET http://storage.test/b/f" },
			{ actor: via, operationId: "row.list", probe: false, route: "GET /jobs/1" },
		])
	})
})

describe("sendAttempt", () => {
	it("sends globals, then the hook's, then the caller's, then the credential, with the body's type", async () => {
		const wire = transport(() => json({}))
		const hooked: unknown[] = []
		const ctx = wireOf(wire, {
			credentials: fixedSource(sendingHeaders({ authorization: "Bearer live" })),
			headers: { g: "1", h: "global" },
			resolveHeaders: async (request) => (hooked.push(request), { h: "hook", i: "hook" }),
		})
		const options = { as: { principal: "alpha" }, body: { n: 1 }, headers: { i: "caller" }, operationId: "row.create" }
		await sendAttempt(prepare(ctx, "POST", "/rows", options), 0, ctx)
		expect(wire.sent[0]?.headers).toEqual({
			authorization: "Bearer live",
			"content-type": "application/json",
			g: "1",
			h: "hook",
			i: "caller",
		})
		await sendAttempt(prepare(ctx, "GET", "/rows", { as: ANON }), 0, ctx)
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
		await expect(sendAttempt(prepare(ctx, "DELETE", "/rows/1", { as: ANON }), 0, ctx)).rejects.toThrow(/read-only run/)
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
		const write = await sendAttempt(prepare(ctx, "POST", "/rows", { as: ANON, body: {} }), 0, ctx)
		expect(write).toMatchObject({ rateLimitCategory: "writes", rateLimitHadRoom: true, rateLimitSource: "tag" })
		const read = await sendAttempt(prepare(ctx, "GET", "/rows", { as: ANON }), 0, ctx)
		expect(read.rateLimitCategory).toBeUndefined()
		limiter.noteBackoff({ method: "DELETE", pathname: "/rows/1" }, 0)
		const cooled = await sendAttempt(prepare(ctx, "DELETE", "/rows/1", { as: ANON }), 0, ctx)
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
		await sendAttempt(prepare(ctx, "GET", "/rows", { as: ANON }), 0, ctx)
		expect(seen).toEqual([`start ${BASE}/rows`, "end GET true"])
		expect(wire.sent[0]?.signal).toBe(true)
		const bare = wireOf(wire, { httpHooks: {} })
		await sendAttempt(prepare(bare, "GET", "/rows", { as: ANON }), 0, bare)
		expect(wire.sent[1]?.signal).toBe(false)
	})
})

describe("sendAttempt redirects and transport", () => {
	it("hands redirects to the caller or the operation, or follows them through the jar", async () => {
		const wire = transport((request) =>
			request.url.endsWith("/a") ? new Response(null, { headers: { location: "/v1/b" }, status: 302 }) : json({}),
		)
		const ctx = wireOf(wire)
		expect((await sendAttempt(prepare(ctx, "GET", "/a", { as: ANON, redirect: "manual" }), 0, ctx)).status).toBe(302)
		const resolving = wireOf(wire, { operationResolver: () => ({ operationId: "a", redirects: true, template: "/a" }) })
		expect((await sendAttempt(prepare(resolving, "GET", "/a", { as: ANON }), 0, resolving)).status).toBe(302)
		const followed = await sendAttempt(prepare(ctx, "GET", "/a", { as: ANON, redirect: "follow" }), 0, ctx)
		expect(followed).toMatchObject({ finalUrl: `${BASE}/b`, status: 200 })
		await sendAttempt(prepare(ctx, "GET", "/a", { as: ANON }), 0, ctx)
		expect(wire.sent.map((request) => request.redirect)).toEqual(["manual", "manual", "manual", "manual", undefined])
	})

	it("records a failed send and raises it as a NetworkError", async () => {
		const ctx = wireOf(transport(() => Promise.reject(refused())))
		const error = await sendAttempt(prepare(ctx, "GET", "/rows", { as: ANON }), 0, ctx).catch(
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(NetworkError)
		expect(ctx.delivered.map((item) => item.exchange.status)).toEqual([0])
	})

	it("uses the global fetch when no transport is given", async () => {
		const wire = transport(() => json({ global: true }))
		vi.stubGlobal("fetch", wire.fetch)
		try {
			const ctx = wireOf(wire, { network: undefined })
			expect((await sendAttempt(prepare(ctx, "GET", "/rows", { as: ANON }), 0, ctx)).responseBody).toEqual({
				global: true,
			})
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
