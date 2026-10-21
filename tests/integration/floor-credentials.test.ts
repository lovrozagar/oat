import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { jsonBody } from "../support/json-body.ts"

/*
 * The contract floor calls what nothing else reached, credential operations included. A logout the
 * recipe names as its revoke, and that the document does not mark destructive, is one: called with
 * the principal's own session it would end that session for the rest of the run. The floor calls it
 * with a dedicated session instead. The principal's own session stays the one it signed in with,
 * accepted on every request, until the store ends it as the run's last call.
 */

let open: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
	for (const server of open) await server.close()
	open = []
})

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const OBJECT = { type: "object" }

function spec(): OpenApiDocument {
	return {
		components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
		info: { title: "sessions", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/login": {
				post: {
					operationId: "auth.login",
					requestBody: {
						...json({ properties: { key: { type: "string" } }, required: ["key"], type: "object" }),
						required: true,
					},
					responses: {
						"200": {
							...json({ properties: { access_token: { type: "string" } }, required: ["access_token"], type: "object" }),
							description: "signed in",
						},
						"400": { description: "malformed" },
						"401": { description: "unknown key" },
					},
					security: [],
				},
			},
			"/v1/logout": {
				post: {
					operationId: "auth.logout",
					responses: { "200": { ...json(OBJECT), description: "signed out" }, "401": { description: "refused" } },
				},
			},
			"/v1/me": {
				get: {
					operationId: "me.read",
					responses: { "200": { ...json(OBJECT), description: "the caller" }, "401": { description: "refused" } },
				},
			},
		},
		security: [{ bearer: [] }],
	} as unknown as OpenApiDocument
}

/** One request as the server answered it: its route, the session it carried, and the status. */
interface Hit {
	route: string
	token: string
	status: number
}

/** Sessions by token: each login issues `session-<n>`, and a logout ends the session it carries. */
async function serve(): Promise<{ hits: Hit[]; url: string }> {
	const document = spec()
	const live = new Set<string>()
	const hits: Hit[] = []
	let issued = 0
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const route = `${(req.method ?? "GET").toUpperCase()} ${url.pathname}`
		let raw = ""
		for await (const chunk of req) raw += chunk
		const token = (req.headers.authorization ?? "").replace(/^Bearer /, "")
		const send = (status: number, value: unknown) => {
			hits.push({ route, status, token })
			res.writeHead(status, { "content-type": "application/json" })
			res.end(JSON.stringify(value))
		}
		if (route === "GET /openapi.json") return send(200, document)
		const body = jsonBody(raw)
		if (body === undefined) return send(400, { error: "malformed json" })
		if (route === "POST /v1/login") {
			if (body["key"] !== "key_alpha") return send(401, { error: "unknown key" })
			issued += 1
			live.add(`session-${issued}`)
			return send(200, { access_token: `session-${issued}` })
		}
		if (!live.has(token)) return send(401, { error: "unauthorized" })
		if (route === "POST /v1/logout") {
			live.delete(token)
			return send(200, { ok: true })
		}
		if (route === "GET /v1/me") return send(200, { id: "alpha" })
		return send(404, { error: "not found" })
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) })
	return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

describe("the contract floor and a credential operation", () => {
	it("calls a logout the recipe names with a dedicated session, and leaves the principal's own one live", async () => {
		const { hits, url } = await serve()
		const result = await run({
			baseUrl: url,
			principals: { alpha: { key: "key_alpha" } },
			security: {
				bearer: {
					login: {
						from: "$.access_token",
						revoke: "auth.logout",
						steps: [{ body: { key: "{principal.key}" }, operationId: "auth.login" }],
					},
				},
			},
			seed: 1,
			spec: `${url}/openapi.json`,
		})
		expect(result.scope.operations.find((op) => op.operationId === "auth.logout")?.status).toBe("passed")
		/* The first session is alpha's own: the run's first request signs it in. */
		const own = hits.filter((hit) => hit.token === "session-1")
		const logouts = hits.filter((hit) => hit.route === "POST /v1/logout" && hit.status === 200)
		/* The floor's logout and the probes' ended other sessions; alpha's is ended once, by the store, last. */
		expect(logouts.filter((hit) => hit.token !== "session-1").length).toBeGreaterThan(0)
		expect(own.filter((hit) => hit.route === "POST /v1/logout")).toEqual([
			{ route: "POST /v1/logout", status: 200, token: "session-1" },
		])
		expect(hits.at(-1)).toEqual({ route: "POST /v1/logout", status: 200, token: "session-1" })
		expect(own.filter((hit) => hit.status === 401)).toEqual([])
	})
})
