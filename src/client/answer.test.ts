import { describe, expect, it } from "vitest"
import { INLINE_BODY_LIMIT } from "../runtime/exchanges/media.ts"
import { NetworkError } from "../errors/network.ts"
import { json, refused, transport } from "./__fixtures__/transport.ts"
import { fixedSource, sendingHeaders } from "./__fixtures__/source.ts"
import { BASE, wireOf } from "./__fixtures__/wire.ts"
import type { Actor } from "./credential-source.ts"
import { prepare, sendAttempt } from "./request.ts"

const ANON: Actor = { anonymous: true }

const resolver = () => ({
	entity: "row",
	operationId: "row.read",
	pathParams: { row_id: "1" },
	template: "/rows/{row_id}",
})

const offline = () => ({ lo: [{ address: "127.0.0.1", internal: true }] }) as never
const online = () => ({ eth0: [{ address: "10.0.0.2", internal: false }] }) as never

describe("a failed send", () => {
	it("is recorded as status 0 under its operation, and raised as a NetworkError", async () => {
		const wire = transport(() => Promise.reject(refused()))
		const ctx = wireOf(wire, { operationResolver: resolver })
		const error = await sendAttempt(prepare(ctx, "GET", "/rows/1", { as: ANON }), 2, ctx).catch(
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(NetworkError)
		expect(error).toMatchObject({ attempts: 3, kind: "refused", method: "GET", url: `${BASE}/rows/1` })
		const [{ exchange, entity }] = ctx.delivered as [(typeof ctx.delivered)[0]]
		expect(entity).toBe("row")
		expect(exchange).toMatchObject({
			network: { attempt: 2, kind: "refused" },
			operationId: "row.read",
			responseBody: { error: "network", kind: "refused" },
			status: 0,
		})
	})

	it("is offline when this machine has no usable interface, whatever the error says", async () => {
		for (const thrown of [refused(), new Error("unrecognised")]) {
			const wire = transport(() => Promise.reject(thrown))
			const ctx = wireOf(wire, { network: { fetchImpl: wire.fetch, interfaces: offline } })
			await expect(sendAttempt(prepare(ctx, "GET", "/rows", { as: ANON }), 0, ctx)).rejects.toMatchObject({
				kind: "offline",
			})
		}
	})

	it("raises an error that is not the network's as it is, recording nothing", async () => {
		const bug = new Error("unrecognised")
		const wire = transport(() => Promise.reject(bug))
		const ctx = wireOf(wire, { network: { fetchImpl: wire.fetch, interfaces: online } })
		await expect(sendAttempt(prepare(ctx, "GET", "/rows", { as: ANON }), 0, ctx)).rejects.toBe(bug)
		expect(ctx.delivered).toEqual([])
	})
})

describe("an answer", () => {
	it("records the request and the answer, frozen, under its entity", async () => {
		const wire = transport(() => json({ id: "1" }, 200, { "x-request-id": "r-1" }))
		const ctx = wireOf(wire, { operationResolver: resolver })
		const exchange = await sendAttempt(prepare(ctx, "GET", "/rows/1", { as: ANON }), 0, ctx)
		expect(Object.isFrozen(exchange)).toBe(true)
		expect(exchange).toMatchObject({
			method: "GET",
			operationId: "row.read",
			pathParams: { row_id: "1" },
			requestId: "r-1",
			responseBody: { id: "1" },
			status: 200,
			template: "/rows/{row_id}",
			url: `${BASE}/rows/1`,
		})
		expect(exchange.requestBytes).toBeGreaterThan(0)
		expect(exchange.responseBytes).toBeGreaterThan(0)
		expect(ctx.delivered.map((item) => item.entity)).toEqual(["row"])
	})
})

describe("an answer's stamps", () => {
	it("names who sent it, with which schemes, why, and its fixture", async () => {
		const ctx = wireOf(
			transport(() => json({})),
			{ credentials: fixedSource(sendingHeaders({ authorization: "Bearer t" })) },
		)
		const options = {
			as: { principal: "alpha" },
			context: { check: "list.reads", purpose: "assertion" as const, subject: "row" },
			fixture: "a.png",
		}
		const exchange = await sendAttempt(prepare(ctx, "GET", "/rows", options), 0, ctx)
		expect(exchange).toMatchObject({
			check: "list.reads",
			fixture: "a.png",
			principal: "alpha",
			purpose: "assertion",
			schemes: ["jwt"],
			subject: "row",
		})
		expect(exchange).not.toHaveProperty("forged")
		const forging = wireOf(
			transport(() => json({}, 401)),
			{ credentials: fixedSource({ kind: "forged", schemes: ["jwt"], sends: {} }) },
		)
		const forged = await sendAttempt(
			prepare(forging, "GET", "/rows", { as: { forged: { scheme: "jwt", value: "f" } } }),
			0,
			forging,
		)
		expect(forged).toMatchObject({ forged: true, schemes: ["jwt"] })
		expect(forged).not.toHaveProperty("principal")
		const plain = await sendAttempt(prepare(wireOf(transport(() => json({}))), "GET", "/rows", { as: ANON }), 0, ctx)
		for (const key of [
			"principal",
			"schemes",
			"forged",
			"template",
			"operationId",
			"fixture",
			"check",
			"redirects",
			"finalUrl",
			"cookies",
		]) {
			expect(plain).not.toHaveProperty(key)
		}
	})
})

describe("an answer's bodies and travels", () => {
	it("keeps a digest of a large body sent and received", async () => {
		const big = "z".repeat(INLINE_BODY_LIMIT + 1)
		const ctx = wireOf(transport(() => new Response(big, { headers: { "content-type": "text/plain" } })))
		const exchange = await sendAttempt(
			prepare(ctx, "POST", "/rows", { as: ANON, body: big, contentType: "text/plain" }),
			0,
			ctx,
		)
		expect(exchange.requestDigest).toMatchObject({ bytes: INLINE_BODY_LIMIT + 1 })
		expect(exchange.responseDigest).toMatchObject({ bytes: INLINE_BODY_LIMIT + 1 })
		const small = await sendAttempt(prepare(ctx, "POST", "/rows", { as: ANON, body: "s" }), 0, ctx)
		expect(small.requestDigest).toBeUndefined()
	})

	it("records the redirects it followed, where it landed, and the cookies it was handed", async () => {
		const wire = transport((request) =>
			request.url.endsWith("/a")
				? new Response(null, { headers: { location: "/v1/b", "set-cookie": "sid=1; Path=/" }, status: 302 })
				: json({}),
		)
		const ctx = wireOf(wire)
		const exchange = await sendAttempt(prepare(ctx, "GET", "/a", { as: ANON, redirect: "follow" }), 0, ctx)
		expect(exchange).toMatchObject({ cookies: { sid: "1" }, finalUrl: `${BASE}/b`, redirects: [{ status: 302 }] })
	})
})
