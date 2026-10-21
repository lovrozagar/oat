import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { formPairs } from "../../src/runtime/body/form-pairs.ts"
import { compactResponseBody } from "../../src/runtime/transcript/compact-response.ts"
import { Client } from "../../src/client/client.ts"
import { toCurl } from "../../src/client/curl.ts"
import { type Resolution, UnsatisfiedSecurity } from "../../src/client/credential-source.ts"
import { createCredentialSource } from "../../src/client/credentials.ts"
import type { SecurityConfig } from "../../src/config/types/security.ts"
import type { CredentialPorts } from "../../src/credentials/ports.ts"
import { createStore } from "../../src/credentials/store.ts"
import { Redactor } from "../../src/security/redact.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

describe("repro scripts", () => {
	it("keeps secrets out of repro scripts, and sends a form field by field", () => {
		const redactor = new Redactor()
		redactor.registerSecret("hunter2-password")
		redactor.registerSecret("Bearer tok_live_123456")
		const curl = toCurl(
			{
				at: 0,
				durationMs: 0,
				method: "POST",
				requestBody: new URLSearchParams([
					["username", "oat"],
					["password", "hunter2-password"],
				]),
				requestBytes: 0,
				requestHeaders: { authorization: "Bearer tok_live_123456" },
				requestId: "",
				responseBody: null,
				responseBytes: 0,
				responseHeaders: {},
				seq: 1,
				status: 200,
				url: "https://x.test/login",
			},
			{ redactor },
		)
		expect(curl).not.toContain("hunter2-password")
		expect(curl).not.toContain("tok_live_123456")
		expect(curl).toContain("--data-urlencode 'username=oat'")
	})
})

describe("form encoding per the operation's encoding", () => {
	it("repeats array keys and spreads objects by default", () => {
		expect(formPairs("tags", ["a", "b"], undefined)).toEqual([
			["tags", "a"],
			["tags", "b"],
		])
		expect(formPairs("point", { x: 1, y: 2 }, undefined)).toEqual([
			["x", "1"],
			["y", "2"],
		])
	})

	it("honours deepObject, explode false and a JSON content type", () => {
		expect(formPairs("point", { x: 1 }, { style: "deepObject" })).toEqual([["point[x]", "1"]])
		expect(formPairs("tags", ["a", "b"], { explode: false, style: "pipeDelimited" })).toEqual([["tags", "a|b"]])
		expect(formPairs("meta", { k: 1 }, { contentType: "application/json" })).toEqual([["meta", '{"k":1}']])
	})
})

let url = ""
let hits = 0
let close = async (): Promise<void> => {}
beforeAll(async () => {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		hits += 1
		/* Drop the connection mid-request: the request may well have been processed. */
		if (req.url === "/reset") {
			req.socket.destroy()
			return
		}
		if (req.url === "/pdf") {
			res.writeHead(200, { "content-type": "application/pdf" })
			res.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff]))
			return
		}
		if (req.url === "/odd-charset") {
			res.writeHead(200, { "content-type": "text/plain; charset=not-a-charset" })
			res.end("plain")
			return
		}
		if (req.url === "/expired") {
			res.writeHead(401, { "content-type": "application/json" })
			res.end("{}")
			return
		}
		res.writeHead(200, { "content-type": "text/plain; charset=iso-8859-1" })
		res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	close = () => new Promise((resolve) => server.close(() => resolve()))
})
afterAll(() => close())

/* A client against the local server that retries a failed request up to `retries` times. */
function retrying(retries: number): Client {
	return new Client({ baseUrl: url, headers: {}, maxInFlight: 4, network: { retries }, redactor: new Redactor() })
}

describe("the client", () => {
	it("never resends a POST whose connection broke mid-request", async () => {
		const client = retrying(3)
		hits = 0
		await expect(client.request("POST", "/reset", { as: { anonymous: true }, body: { a: 1 } })).rejects.toThrow(
			/^POST http:\/\/127\.0\.0\.1:\d+\/reset failed \(reset: the connection was reset\)$/,
		)
		expect(hits).toBe(1)
	})

	it("resends a GET, which is safe to repeat", async () => {
		const client = retrying(1)
		hits = 0
		await expect(client.get("/reset", { as: { anonymous: true } })).rejects.toThrow(
			/^GET http:\/\/127\.0\.0\.1:\d+\/reset failed \(reset: the connection was reset\)$/,
		)
		expect(hits).toBe(2)
	})

	it("decodes text by its declared charset and counts the bytes on the wire", async () => {
		const exchange = await new Client({ baseUrl: url, redactor: new Redactor() }).get("/latin1", {
			as: { anonymous: true },
		})
		expect(exchange.responseBody).toBe("café")
		expect(exchange.responseBytes).toBeGreaterThan(0)
	})
	it("reads a body whose charset label is unknown as UTF-8", async () => {
		expect(
			(await new Client({ baseUrl: url, redactor: new Redactor() }).get("/odd-charset", { as: { anonymous: true } }))
				.responseBody,
		).toBe("plain")
	})

	it("keeps a binary body as its bytes", async () => {
		const exchange = await new Client({ baseUrl: url, redactor: new Redactor() }).get("/pdf", {
			as: { anonymous: true },
		})
		expect(exchange.responseBody).toBeInstanceOf(Uint8Array)
		expect(exchange.responseBytes).toBeGreaterThan(5)
	})

	it("reads an array under text/event-stream as frames only when it is frames", async () => {
		expect(await compactResponseBody([1, 2], { "content-type": "text/event-stream" })).toEqual([1, 2])
	})
})

/* One secured operation the local server answers 401, as an expired session would be. */
const EXPIRED_DOC = {
	components: { securitySchemes: { jwt: { scheme: "bearer", type: "http" } } },
	info: { title: "expired", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/expired": {
			get: { operationId: "expired.get", responses: { "401": { description: "expired" } }, security: [{ jwt: [] }] },
		},
	},
} as unknown as OpenApiDocument

/* A jwt with a login and a refresh of its own. */
const RENEWABLE: SecurityConfig = {
	jwt: {
		login: { from: "$.token", steps: [{ operationId: "auth.login" }] },
		refresh: { from: "$.token", steps: [{ operationId: "auth.refresh" }] },
	},
}

const unexpected = (what: string) => Promise.reject(new Error(`unexpected ${what}`))

/* Ports whose first login issues a token, and whose every later step (the refresh, the fallback login) is refused. */
function renewalRefused(steps: string[]): CredentialPorts {
	return {
		operations: { call: () => unexpected("call") },
		steps: {
			run: async (run) => {
				const step = run.map((one) => ("operationId" in one ? one.operationId : "?")).join(",")
				steps.push(step)
				if (steps.length > 1) throw new Error(`${step} answered 401`)
				return { answer: { body: { token: "token-1" }, cookies: {}, headers: {}, status: 200 }, scope: {} }
			},
		},
		tokens: { post: () => unexpected("post") },
	}
}

describe("a principal whose renewal fails", () => {
	it("answers the refusal as it is when its renewal fails, and sends nothing more", async () => {
		let resolved = 0
		const sending: Resolution = {
			block: () => undefined,
			kind: "sends",
			principal: "alpha",
			refresh: async () => ({
				kind: "blocked",
				reason: "alpha's refresh for bearer failed: refresh endpoint said 500",
			}),
			schemes: ["bearer"],
			secrets: { cookies: [], headers: ["authorization"], query: [], values: ["Bearer stale"] },
			sends: { bearer: { cookies: {}, headers: { authorization: "Bearer stale" }, query: {} } },
			sentValues: { bearer: "stale" },
		}
		const client = new Client({
			baseUrl: url,
			credentials: {
				resolve: async () => {
					resolved += 1
					return sending
				},
			},
			redactor: new Redactor(),
		})
		hits = 0
		const refused = await client.get("/expired", { as: { principal: "alpha" } })
		expect(refused.status).toBe(401)
		expect([hits, resolved]).toEqual([1, 1])
	})

	it("blocks its principal through the real store: the next request is refused before it is sent", async () => {
		const steps: string[] = []
		const ports = renewalRefused(steps)
		const model = buildModel(EXPIRED_DOC)
		const principals = { alpha: {} }
		const store = createStore({ ports, principals, schemes: model.schemes, security: RENEWABLE })
		const client = new Client({
			baseUrl: url,
			credentials: createCredentialSource({ model, principals, security: RENEWABLE, store }),
			operationResolver: (method, path) =>
				method === "GET" && path === "/expired" ? { operationId: "expired.get", template: path } : null,
			redactor: new Redactor(),
		})
		hits = 0
		expect((await client.get("/expired", { as: { principal: "alpha" } })).status).toBe(401)
		expect([hits, steps]).toEqual([1, ["auth.login", "auth.refresh", "auth.login"]])
		const next = client.get("/expired", { as: { principal: "alpha" } })
		await expect(next).rejects.toBeInstanceOf(UnsatisfiedSecurity)
		await expect(next).rejects.toMatchObject({
			kind: "blocked",
			reason:
				"renewal for alpha/jwt: the refresh failed (auth.refresh answered 401), then acquiring afresh failed (auth.login answered 401)",
		})
		expect(hits).toBe(1)
	})
})
