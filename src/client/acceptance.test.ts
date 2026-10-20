import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { FenceRequest } from "../config/types/hooks.ts"
import type { SecurityConfig } from "../config/types/security.ts"
import { answerOf, fakePorts } from "../credentials/__fixtures__/ports.ts"
import { createExchangeJournal } from "../runtime/exchanges/journal.ts"
import type { Exchange } from "../runtime/exchange.ts"
import { Fence } from "../runtime/fence.ts"
import { REDACTED } from "../security/redact.ts"
import { anyrow } from "../spec/security/__fixtures__/documents.ts"
import { BASE, clientOf, placesDoc } from "./__fixtures__/credentials.ts"
import { json } from "./__fixtures__/transport.ts"
import { CredentialCollision, UnsatisfiedSecurity } from "./credential-source.ts"
import { toCurl } from "./curl.ts"

/*
 * What a request carries, end to end through the client: the adapter over a real store with fake
 * ports, and a fake fetch. Each case is one of phase 8's acceptance bars or contract rules.
 */

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/* The exchange file the run's journal writes for `exchange`, as text. */
async function journalled(exchange: Exchange, redactor: Parameters<typeof createExchangeJournal>[1]): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "oat-client-acceptance-"))
	dirs.push(dir)
	const journal = createExchangeJournal(dir, redactor)
	await journal.record(exchange)
	await journal.flush()
	const line = JSON.parse(readFileSync(join(dir, "exchanges.jsonl"), "utf8").trim()) as { file: string }
	return readFileSync(join(dir, line.file), "utf8")
}

const keyRecipe = { format: "ApiKey {credential}", holds: ["rows:read"], static: "key_machine_123456" }
const places = {
	hdr: { static: "hdr-secret-value-1" },
	jwt: { static: "jwt-secret-value-1" },
	qry: { static: "qry-secret-value-1" },
	sess: { static: "sess-secret-value-1" },
} as SecurityConfig

/* A backend that accepts only the token a renewal issued. */
const secondTokenOnly = (request: { headers: Record<string, string> }): Response =>
	json({}, request.headers.Authorization === "Bearer token-2" ? 200 : 401)

/* A backend that sends every request to another origin, echoing the query credential. */
const elsewhere = (request: { url: string }): Response =>
	request.url.startsWith(BASE)
		? new Response(null, { headers: { location: "http://other.test/next?k=echoed&x=1" }, status: 302 })
		: json({})

describe("bar 1: exactly the credentials of one satisfied alternative", () => {
	it("sends anyrow's apiKey alternative as ApiKey in Authorization, and records it redacted", async () => {
		const { client, sent } = clientOf({
			answer: () => json({}),
			client: { baseUrl: "http://api.test" },
			doc: anyrow,
			security: { apiKey: keyRecipe } as SecurityConfig,
		})
		const exchange = await client.get("/v1/rows", { as: { principal: "alpha" } })
		expect(sent[0]?.headers).toEqual({ Authorization: "ApiKey key_machine_123456" })
		expect(exchange).toMatchObject({ operationId: "row.list", principal: "alpha", schemes: ["apiKey"] })
		expect(exchange).not.toHaveProperty("forged")
		const file = JSON.parse(await journalled(exchange, client.redactor)) as { requestHeaders: object }
		expect(file.requestHeaders).toEqual({ Authorization: `ApiKey ${REDACTED}` })
	})

	it("sends the jwt when the principal holds both, since it comes first", async () => {
		const security = { apiKey: keyRecipe, jwt: { static: "jwt_alpha_123456" } } as SecurityConfig
		const { client, sent } = clientOf({
			answer: () => json({}),
			client: { baseUrl: "http://api.test" },
			doc: anyrow,
			security,
		})
		const exchange = await client.get("/v1/rows", { as: { principal: "alpha" } })
		expect(sent[0]?.headers).toEqual({ Authorization: "Bearer jwt_alpha_123456" })
		expect(exchange.schemes).toEqual(["jwt"])
	})
})

describe("bar 2: an anonymous operation sends no credential", () => {
	it("sends no header, query or cookie for [] or an anonymous actor, and still names the acting principal", async () => {
		const { client, sent } = clientOf({ answer: () => json({}), doc: placesDoc, security: places })
		const open = await client.get("/open", { as: { principal: "alpha" } })
		await client.get("/all", { as: { anonymous: true } })
		for (const request of sent) {
			expect(request.headers).toEqual({})
			expect(new URL(request.url).search).toBe("")
		}
		expect(open.principal).toBe("alpha")
		expect(open).not.toHaveProperty("schemes")
	})
})

describe("bar 4: redaction derives from placements", () => {
	it("scrubs a header, a query and a cookie placement by name and value in the journal and the curl script", async () => {
		const echo = "echoed hdr-secret-value-1 qry-secret-value-1 sess-secret-value-1"
		const { client, sent } = clientOf({ answer: () => json({ echo }), doc: placesDoc, security: places })
		const exchange = await client.get("/all", { as: { principal: "alpha" } })
		expect(sent[0]?.headers).toEqual({ "X-Key": "hdr-secret-value-1", cookie: "sess=sess-secret-value-1" })
		expect(sent[0]?.url).toBe(`${BASE}/all?k=qry-secret-value-1`)
		expect(exchange.schemes).toEqual(["hdr", "qry", "sess"])
		const file = await journalled(exchange, client.redactor)
		const curl = toCurl(exchange, { redactor: client.redactor })
		for (const written of [file, curl]) expect(written).not.toMatch(/secret-value/)
		const parsed = JSON.parse(file) as { requestHeaders: object; url: string; responseBody: unknown }
		expect(parsed.requestHeaders).toEqual({ "X-Key": REDACTED, cookie: REDACTED })
		expect(new URL(parsed.url).searchParams.get("k")).toBe(REDACTED)
		expect(parsed.responseBody).toEqual({ echo: `echoed ${REDACTED} ${REDACTED} ${REDACTED}` })
		expect(curl).toContain('-H "X-Key: $TOKEN"')
	})
})

describe("bar 5: refresh is single-flight", () => {
	it("renews once for 10 parallel 401s, and retries each request once", async () => {
		let issued = 0
		const { ports, recorded } = fakePorts({
			run: async () => ({ answer: answerOf({ token: `token-${++issued}` }), scope: {} }),
		})
		const security = { jwt: { login: { from: "$.token", steps: [{ operationId: "auth.login" }] } } } as SecurityConfig
		const { client, sent } = clientOf({ answer: secondTokenOnly, doc: placesDoc, ports, security })
		const requests = Array.from({ length: 10 }, () => client.get("/me", { as: { principal: "alpha" } }))
		const exchanges = await Promise.all(requests)
		expect(exchanges.map((exchange) => exchange.status)).toEqual(Array(10).fill(200))
		expect(recorded.runs).toHaveLength(2)
		expect(sent).toHaveLength(20)
		expect(client.transcript.filter((exchange) => exchange.superseded === true)).toHaveLength(10)
	})

	it("refreshes at most once per request, and answers the second 401 as it is", async () => {
		let issued = 0
		const { ports, recorded } = fakePorts({
			run: async () => ({ answer: answerOf({ token: `token-${++issued}` }), scope: {} }),
		})
		const security = { jwt: { login: { from: "$.token", steps: [{ operationId: "auth.login" }] } } } as SecurityConfig
		const { client, sent } = clientOf({ answer: () => json({}, 401), doc: placesDoc, ports, security })
		expect((await client.get("/me", { as: { principal: "alpha" } })).status).toBe(401)
		expect([recorded.runs.length, sent.length]).toEqual([2, 2])
		expect(sent.map((request) => request.headers.Authorization)).toEqual(["Bearer token-1", "Bearer token-2"])
	})
})

/* A jwt login issuing `token-<n>`, whose declared refresh the server refuses. */
function refusedRefresh() {
	let issued = 0
	const steps: string[] = []
	const { ports } = fakePorts({
		run: async (call) => {
			const step = call.steps[0] as { operationId: string }
			steps.push(step.operationId)
			if (step.operationId === "auth.refresh") throw new Error("auth step 1 answered 401")
			return { answer: answerOf({ token: `token-${++issued}` }), scope: {} }
		},
	})
	const security = {
		jwt: {
			login: { from: "$.token", steps: [{ operationId: "auth.login" }] },
			refresh: { from: "$.token", steps: [{ operationId: "auth.refresh" }] },
		},
	} as SecurityConfig
	return { ports, security, steps }
}

describe("a refused refresh", () => {
	it("is followed by exactly one login, and the retry carries its session", async () => {
		const { ports, security, steps } = refusedRefresh()
		const { client, sent } = clientOf({ answer: secondTokenOnly, doc: placesDoc, ports, security })
		expect((await client.get("/me", { as: { principal: "alpha" } })).status).toBe(200)
		expect(steps).toEqual(["auth.login", "auth.refresh", "auth.login"])
		expect(sent.map((request) => request.headers.Authorization)).toEqual(["Bearer token-1", "Bearer token-2"])
	})

	it("renews no more for that request when the retry after the login is refused too", async () => {
		const { ports, security, steps } = refusedRefresh()
		const { client, sent } = clientOf({ answer: () => json({}, 401), doc: placesDoc, ports, security })
		expect((await client.get("/me", { as: { principal: "alpha" } })).status).toBe(401)
		expect([steps, sent.length]).toEqual([["auth.login", "auth.refresh", "auth.login"], 2])
	})
})

describe("a renewal that fails", () => {
	it("answers the 401 as it is, and BLOCKS the principal for the requests after it", async () => {
		let runs = 0
		const { ports } = fakePorts({
			run: async () => {
				runs += 1
				if (runs > 1) throw new Error("auth step 1 answered 401")
				return { answer: answerOf({ token: "token-1" }), scope: {} }
			},
		})
		const security = { jwt: { login: { from: "$.token", steps: [{ operationId: "auth.login" }] } } } as SecurityConfig
		const { client, sent } = clientOf({ answer: () => json({}, 401), doc: placesDoc, ports, security })
		expect((await client.get("/me", { as: { principal: "alpha" } })).status).toBe(401)
		await expect(client.get("/me", { as: { principal: "alpha" } })).rejects.toMatchObject({
			kind: "blocked",
			reason: expect.stringContaining("auth step 1 answered 401"),
		})
		expect([runs, sent.length]).toEqual([2, 1])
	})
})

describe("the collision guard", () => {
	it("refuses a caller, hook or global header under the placed name, and sends nothing", async () => {
		const collides = 'header "x-key" collides with the hdr credential placement'
		const caller = clientOf({ answer: () => json({}), doc: placesDoc, security: places })
		const asking = caller.client.get("/h", { as: { principal: "alpha" }, headers: { "x-key": "mine" } })
		await expect(asking).rejects.toEqual(new CredentialCollision("header", { name: "x-key", scheme: "hdr" }))
		await expect(asking).rejects.toThrow(collides)
		const hooked = clientOf({
			answer: () => json({}),
			client: { resolveHeaders: async () => ({ "x-key": "hook" }) },
			doc: placesDoc,
			security: places,
		})
		await expect(hooked.client.get("/h", { as: { principal: "alpha" } })).rejects.toThrow(collides)
		const global = clientOf({
			answer: () => json({}),
			client: { headers: { "x-key": "g" } },
			doc: placesDoc,
			security: places,
		})
		await expect(global.client.get("/h", { as: { principal: "alpha" } })).rejects.toThrow(collides)
		await expect(global.client.get("/q", { as: { principal: "alpha" }, query: { k: "mine" } })).rejects.toThrow(
			'query "k" collides with the qry credential placement',
		)
		expect([...caller.sent, ...hooked.sent, ...global.sent]).toEqual([])
	})
})

describe("forged values and probes", () => {
	it("places a forged apiKey in the query string under the scheme's name, unredacted", async () => {
		const { client, sent } = clientOf({ answer: () => json({}, 401), doc: placesDoc, security: places })
		const exchange = await client.get("/q", { as: { forged: { scheme: "qry", value: "forged-key-1" } } })
		expect(sent[0]?.url).toBe(`${BASE}/q?k=forged-key-1`)
		expect(exchange).toMatchObject({ forged: true, schemes: ["qry"], status: 401 })
		expect(exchange).not.toHaveProperty("principal")
		expect(JSON.parse(await journalled(exchange, client.redactor))).toMatchObject({ url: `${BASE}/q?k=forged-key-1` })
	})

	it("places a forged value under the config's format", async () => {
		const { client, sent } = clientOf({
			answer: () => json({}),
			client: { baseUrl: "http://api.test" },
			doc: anyrow,
			security: { apiKey: keyRecipe } as SecurityConfig,
		})
		await client.get("/v1/rows", { as: { forged: { scheme: "apiKey", value: "forged-2" } } })
		expect(sent[0]?.headers).toEqual({ Authorization: "ApiKey forged-2" })
	})

	it("neither refreshes nor retries a forged request or a probe on a 401", async () => {
		const { ports, recorded } = fakePorts({ run: async () => ({ answer: answerOf({ token: "t-1" }), scope: {} }) })
		const security = { jwt: { login: { from: "$.token", steps: [{ operationId: "auth.login" }] } } } as SecurityConfig
		const { client, sent } = clientOf({ answer: () => json({}, 401), doc: placesDoc, ports, security })
		const forged = await client.get("/me", { as: { forged: { scheme: "jwt", value: "nope" } } })
		const probe = await client.get("/me", { as: { principal: "alpha" }, probe: true })
		expect([forged.status, probe.status]).toEqual([401, 401])
		expect(sent.map((request) => request.headers.Authorization)).toEqual(["Bearer nope", "Bearer t-1"])
		expect(recorded.runs).toHaveLength(1)
		expect(client.transcript.some((exchange) => exchange.superseded === true)).toBe(false)
	})
})

describe("unsatisfied security", () => {
	it("is raised before anything is sent, with the reason and the kind", async () => {
		const { client, sent } = clientOf({
			answer: () => json({}),
			client: { baseUrl: "http://api.test" },
			doc: anyrow,
			security: {},
		})
		const error = await client.get("/v1/rows", { as: { principal: "alpha" } }).catch((caught: unknown) => caught)
		expect(error).toEqual(new UnsatisfiedSecurity("unsatisfied", "no credential for jwt; no credential for apiKey"))
		const { ports } = fakePorts({ run: () => Promise.reject(new Error("login answered 500")) })
		const security = { jwt: { login: { from: "$.token", steps: [{ operationId: "auth.login" }] } } } as SecurityConfig
		const blocked = clientOf({ answer: () => json({}), doc: placesDoc, ports, security })
		await expect(blocked.client.get("/me", { as: { principal: "alpha" } })).rejects.toMatchObject({
			kind: "blocked",
			reason: expect.stringContaining("login answered 500"),
		})
		expect([...sent, ...blocked.sent, ...client.transcript]).toEqual([])
	})
})

describe("a cross-origin redirect", () => {
	it("strips every placed header, query parameter and cookie", async () => {
		const { client, sent } = clientOf({ answer: elsewhere, doc: placesDoc, security: places })
		const exchange = await client.get("/all", {
			as: { principal: "alpha" },
			headers: { accept: "json" },
			redirect: "follow",
		})
		expect(exchange.status).toBe(200)
		expect(sent[1]).toMatchObject({ headers: { accept: "json" }, url: "http://other.test/next?x=1" })
	})
})

describe("a continuation: a URL taken from a response", () => {
	const bearer = { jwt: { static: "jwt-secret-value-1" }, qry: { static: "qry-secret-value-1" } } as SecurityConfig

	it("sends an undocumented same-origin poll URL with the originating bearer", async () => {
		const { client, sent } = clientOf({ answer: () => json({}), doc: placesDoc, security: bearer })
		const start = await client.get("/me", { as: { principal: "alpha" } })
		const poll = await client.get(`${BASE}/jobs/1/status`, { as: { principal: "alpha", via: start } })
		expect(sent[1]?.headers).toEqual({ Authorization: "Bearer jwt-secret-value-1" })
		expect([poll.principal, poll.schemes]).toEqual([start.principal, start.schemes])
	})

	it("resolves a same-origin next link against the operation it matches", async () => {
		const { client, sent } = clientOf({ answer: () => json({}), doc: placesDoc, security: bearer })
		const start = await client.get("/me", { as: { principal: "alpha" } })
		const next = await client.get(`${BASE}/q?page=2`, { as: { principal: "alpha", via: start } })
		expect(next).toMatchObject({ operationId: "q.get", schemes: ["qry"] })
		expect(sent[1]?.url).toBe(`${BASE}/q?page=2&k=qry-secret-value-1`)
	})

	it("sends no credential to a foreign-origin Location", async () => {
		const { client, sent } = clientOf({ answer: () => json({}), doc: placesDoc, security: bearer })
		const start = await client.get("/me", { as: { principal: "alpha" } })
		const stored = await client.get("http://storage.test/b/f?sig=1", { as: { principal: "alpha", via: start } })
		expect(sent[1]).toMatchObject({ headers: {}, url: "http://storage.test/b/f?sig=1" })
		expect(stored).not.toHaveProperty("principal")
		expect(stored).not.toHaveProperty("schemes")
	})
})

/* What a principal's request that matches no documented operation, and names no scheme, is refused with. */
const unmatched = (route: string): UnsatisfiedSecurity =>
	new UnsatisfiedSecurity(
		"unsatisfied",
		`no documented operation matches ${route}: name its scheme with as: { principal, scheme }`,
	)

describe("a request that matches no documented operation", () => {
	const bearer = { jwt: { static: "jwt-secret-value-1" } } as SecurityConfig

	it("is refused before sending when the principal names no scheme, relative or foreign", async () => {
		const { client, sent } = clientOf({ answer: () => json({}), doc: placesDoc, security: bearer })
		await expect(client.get("/jobs/1", { as: { principal: "alpha" } })).rejects.toEqual(unmatched("GET /jobs/1"))
		const foreign = client.get("http://other.test/x?sig=1", { as: { principal: "alpha" } })
		await expect(foreign).rejects.toEqual(unmatched("GET http://other.test/x"))
		expect(sent).toEqual([])
	})

	it("places the named scheme's credential", async () => {
		const { client, sent } = clientOf({ answer: () => json({}), doc: placesDoc, security: bearer })
		const named = await client.get("/jobs/1", { as: { principal: "alpha", scheme: "jwt" } })
		expect(sent[0]?.headers).toEqual({ Authorization: "Bearer jwt-secret-value-1" })
		expect(named).toMatchObject({ principal: "alpha", schemes: ["jwt"] })
	})
})

describe("the fence", () => {
	it("sees who sends and under which schemes, beside the headers as sent", async () => {
		const asked: FenceRequest[] = []
		const fence = new Fence((request) => (asked.push(request), { allow: true }))
		const bearer = { jwt: { static: "jwt-secret-value-1" } } as SecurityConfig
		const { client } = clientOf({ answer: () => json({}), client: { fence }, doc: placesDoc, security: bearer })
		await client.get("/me", { as: { principal: "alpha" } })
		await client.get("/me", { as: { forged: { scheme: "jwt", value: "forged-3" } } })
		await client.get("/open", { as: { anonymous: true } })
		expect(asked.map(({ forged, headers, principal, schemes }) => ({ forged, headers, principal, schemes }))).toEqual([
			{
				forged: undefined,
				headers: { Authorization: "Bearer jwt-secret-value-1" },
				principal: "alpha",
				schemes: ["jwt"],
			},
			{ forged: true, headers: { Authorization: "Bearer forged-3" }, principal: undefined, schemes: ["jwt"] },
			{ forged: undefined, headers: {}, principal: undefined, schemes: undefined },
		])
	})
})
