import { describe, expect, it } from "vitest"
import { isBodyRef } from "../runtime/exchange.ts"
import { Redactor } from "../security/redact.ts"
import { type Answer, json, transport } from "./__fixtures__/transport.ts"
import { Client } from "./client.ts"
import type { CredentialSource, Resolution } from "./credential-source.ts"
import type { ClientOptions } from "./types.ts"

/* What the client records of an exchange: what it resolved to, who asked and why, and what it kept. */

const BASE = "http://api.test/api"

function clientOf(answer: Answer, more: Partial<ClientOptions> = {}): Client {
	const wire = transport(answer)
	return new Client({ baseUrl: BASE, network: { fetchImpl: wire.fetch }, redactor: new Redactor(), ...more })
}

const echo: Answer = (request) => json({ path: new URL(request.url).pathname })

/* alpha's bearer token `value`, renewed by `refresh`. */
function bearer(value: string, refresh: () => Promise<Resolution>): Resolution {
	const authorization = `Bearer ${value}`
	return {
		block: () => undefined,
		kind: "sends",
		principal: "alpha",
		refresh,
		schemes: ["bearer"],
		secrets: { cookies: [], headers: ["authorization"], query: [], values: [authorization] },
		sends: { bearer: { cookies: {}, headers: { authorization }, query: {} } },
		sentValues: { bearer: value },
	}
}

/* A source that sends alpha's token for alpha, and nothing for anyone else. */
const alphaSource = (resolution: Resolution): CredentialSource => ({
	resolve: async ({ actor }) =>
		"principal" in actor && actor.principal === "alpha" ? resolution : { kind: "anonymous" },
})

/* A client below the base path that sends alpha's token and resolves the table read. */
function resolvingClient(): Client {
	return clientOf(echo, {
		credentials: alphaSource(bearer("a", async () => ({ kind: "anonymous" }))),
		operationResolver: (method, path) =>
			method === "GET" && /^\/v1\/tables\/[^/]+$/.test(path)
				? { operationId: "table.get", template: "/v1/tables/{table_id}" }
				: null,
	})
}

describe("exchange model", () => {
	it("resolves operations below the base path and stamps who asked and why", async () => {
		const client = resolvingClient()
		expect(client.relativePath(`${BASE}/v1/tables/1`)).toBe("/v1/tables/1")
		/* A sibling path that merely starts with the same letters is not below the base. */
		const sibling = new URL(BASE)
		sibling.pathname = `${sibling.pathname.replace(/\/$/, "")}v2/v1/tables/1`
		expect(client.relativePath(sibling.toString())).toBe(sibling.pathname)

		const view = client.view({ check: "c.one", subject: "table" })
		const exchange = await view.get("/v1/tables/7", { as: { principal: "alpha" }, context: { purpose: "probe" } })
		expect(exchange).toMatchObject({
			check: "c.one",
			operationId: "table.get",
			principal: "alpha",
			purpose: "probe",
			schemes: ["bearer"],
			subject: "table",
			template: "/v1/tables/{table_id}",
		})
		expect(client.exchangesFor("table.get")).toHaveLength(1)
		expect(client.exchangesFor("nothing")).toEqual([])
		const nested = view.view({ purpose: "assertion" })
		expect((await nested.request("GET", "/v1/other", { as: { anonymous: true } })).check).toBe("c.one")
	})

	it("hands the caller the real body and keeps a compact copy", async () => {
		const client = clientOf(() => json({ items: "x".repeat(300 * 1024) }))
		const exchange = await client.get("/v1/big", { as: { anonymous: true } })
		expect(typeof (exchange.responseBody as { items: string }).items).toBe("string")
		expect(isBodyRef(client.transcript.at(-1)?.responseBody)).toBe(true)
	})

	it("marks an answer asked again after a refresh as superseded", async () => {
		let refreshed = 0
		const renewed = bearer("b", async () => ({ kind: "anonymous" }))
		const stale = bearer("a", async () => {
			refreshed++
			return renewed
		})
		/* The guarded read is refused once, and answered after that. */
		const client = clientOf(
			(_sent, index) => json(index === 0 ? {} : { path: "/api/v1/guarded" }, index === 0 ? 401 : 200),
			{
				credentials: alphaSource(stale),
			},
		)
		const exchange = await client.get("/v1/guarded", { as: { principal: "alpha" } })
		expect(refreshed).toBe(1)
		expect(exchange.requestHeaders["authorization"]).not.toBe(client.transcript[0]?.requestHeaders["authorization"])
		expect(exchange.status).toBe(200)
		expect(client.transcript.map((item) => [item.status, item.superseded === true])).toEqual([
			[401, true],
			[200, false],
		])
	})
})
