import { describe, expect, it } from "vitest"
import type { Client } from "../../client/client.ts"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import type { CredentialRecord } from "../../credentials/ports.ts"
import type { EntityModel } from "../../spec/graph/types.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { type Answer, fakeClient, modelOf, type Responder } from "../checks/__fixtures__/harness.ts"
import { credentialRecords } from "./credential-records.ts"

/*
 * Keys with a read of their own, tokens revoked by a POST and read only through their list, pins
 * whose rows name no identity, things nothing reads, and a session ended by a path that names none.
 */

const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })
const ok = { "200": { description: "ok" } }
const rows = { content: { "application/json": { schema: { items: { type: "object" }, type: "array" } } } }
const paged = {
	content: {
		"application/json": {
			schema: {
				properties: { has_more: { type: "boolean" }, items: { items: { type: "object" }, type: "array" } },
				type: "object",
			},
		},
	},
}

const MODEL = modelOf({
	info: { title: "keys", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/keys/{key_id}": {
			delete: { operationId: "keys.delete", parameters: [param("key_id")], responses: ok },
			get: { operationId: "keys.get", parameters: [param("key_id")], responses: ok },
		},
		"/orgs/{org_id}/tokens": {
			get: {
				operationId: "tokens.list",
				parameters: [param("org_id"), { in: "query", name: "page", schema: { minimum: 1, type: "integer" } }],
				responses: { "200": { ...paged, description: "ok" } },
			},
		},
		"/orgs/{org_id}/tokens/{token_id}": {
			delete: { operationId: "tokens.delete", parameters: [param("org_id"), param("token_id")], responses: ok },
		},
		"/orgs/{org_id}/tokens/{token_id}/revoke": {
			post: { operationId: "tokens.revoke", parameters: [param("org_id"), param("token_id")], responses: ok },
		},
		"/widgets": { get: { operationId: "widgets.list", responses: { "200": { ...rows, description: "ok" } } } },
		"/widgets/{widget_id}": {
			delete: { operationId: "widgets.delete", parameters: [param("widget_id")], responses: ok },
		},
		"/pins": { get: { operationId: "pins.list", responses: ok } },
		"/pins/{pin_id}": { delete: { operationId: "pins.delete", parameters: [param("pin_id")], responses: ok } },
		"/session": { delete: { operationId: "session.end", responses: ok } },
		"/things/{thing_id}": { delete: { operationId: "things.delete", parameters: [param("thing_id")], responses: ok } },
	},
} as unknown as OpenApiDocument)
/* No document here leaves an entity with a path parameter unidentified, so the model says it directly. */
const pins = MODEL.entities.get("pin") as EntityModel
pins.identity = null

const AS = { principal: "alpha#probe-1", scheme: "bearer" }

function recordOf(operationId: string, scope: Record<string, string>): CredentialRecord {
	return { as: AS, operationId, scope: { credential: "secret", ...scope } }
}

/* Alpha's probe is bound to org o1; anyone else to nothing. */
const scopeOf = (principal: string) => (principal === AS.principal ? { org_id: "o1" } : {})

/** The records port over a fake client answering `respond`. */
function recordsOver(respond: Responder = () => undefined) {
	const { client, sent } = fakeClient(respond)
	const records = credentialRecords({ client: () => client, model: MODEL, scopeOf })
	return { client, records, sent }
}

const KEY = recordOf("keys.delete", { key_id: "k7" })
const TOKEN = recordOf("tokens.revoke", { token_id: "t1" })

/** The records port over a client whose every read rejects with `error`. */
function failing(error: Error) {
	const client = { get: () => Promise.reject(error) } as unknown as Client
	return credentialRecords({ client: () => client, model: MODEL, scopeOf })
}

describe("credentialRecords: removed", () => {
	it("is removed once an accepted DELETE of its own path went out, never by a refused one or another key's", async () => {
		const answers: Record<string, Answer> = { "/keys/k7": { status: 404 }, "/keys/k8": { status: 204 } }
		const { client, records } = recordsOver((_method, path) => answers[path])
		await client.request("DELETE", "/keys/k7", { as: { anonymous: true } })
		await client.request("DELETE", "/keys/k8", { as: { anonymous: true } })
		expect(records.removed(KEY)).toBe(false)
		answers["/keys/k7"] = { status: 204 }
		await client.request("DELETE", "/keys/k7", { as: { anonymous: true } })
		expect(records.removed(KEY)).toBe(true)
	})

	it("is removed by its entity's DELETE when the revoke is a POST, never by that POST alone", async () => {
		const { client, records } = recordsOver(() => ({ status: 204 }))
		await client.request("POST", "/orgs/o1/tokens/t1/revoke", { as: { anonymous: true } })
		expect(records.removed(TOKEN)).toBe(false)
		await client.request("DELETE", "/orgs/o1/tokens/t1", { as: { anonymous: true } })
		expect(records.removed(TOKEN)).toBe(true)
	})

	it("addresses a record its mint answered only as `id`, whatever its own path calls the parameter", async () => {
		const answered = recordOf("keys.delete", { id: "k7" })
		const { client, records, sent } = recordsOver(() => ({ status: 404 }))
		await client.request("DELETE", "/keys/k7", { as: { anonymous: true } })
		expect(records.removed(answered)).toBe(false)
		expect(await records.gone(answered)).toBe(true)
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["DELETE /keys/k7", "GET /keys/k7"])
	})

	it("is never removed by a path that names no record, or one its scope cannot fill", async () => {
		const { client, records } = recordsOver(() => ({ status: 204 }))
		await client.request("DELETE", "/session", { as: { anonymous: true } })
		expect(records.removed(recordOf("session.end", {}))).toBe(false)
		expect(records.removed(recordOf("keys.delete", {}))).toBe(false)
	})
})

describe("credentialRecords: gone", () => {
	it("reads the record by its entity's read, as the credential's sender: 404 and 410 are gone", async () => {
		const status = { now: 404 }
		const { records, sent } = recordsOver(() => ({ status: status.now }))
		expect(await records.gone(KEY)).toBe(true)
		status.now = 410
		expect(await records.gone(KEY)).toBe(true)
		status.now = 200
		expect(await records.gone(KEY)).toBe(false)
		expect(sent.map(({ method, options, path }) => [method, path, options.as, options.operationId])).toEqual(
			Array.from({ length: 3 }, () => ["GET", "/keys/k7", AS, "keys.get"]),
		)
	})

	it("reads nothing for a record with no id, no read or list, a list it cannot fill, or one without identity", async () => {
		const { records, sent } = recordsOver()
		const orphan = { ...recordOf("tokens.revoke", { token_id: "t1" }), as: { principal: "beta", scheme: "bearer" } }
		for (const record of [
			recordOf("session.end", {}),
			recordOf("things.delete", { thing_id: "x1" }),
			orphan,
			recordOf("pins.delete", { pin_id: "p1" }),
		]) {
			expect(await records.gone(record)).toBe(false)
		}
		expect(sent.map(({ path }) => path)).toEqual([])
	})

	it("claims nothing for a read that cannot be sent, and rethrows any other failure", async () => {
		expect(await failing(new UnsatisfiedSecurity("blocked", "no key")).gone(KEY)).toBe(false)
		await expect(failing(new Error("boom")).gone(KEY)).rejects.toThrow("boom")
	})
})

describe("credentialRecords: gone from its list", () => {
	it("reads a record with no read of its own in its list, page by page, by the scope its principal holds", async () => {
		const pages: Record<string, string[]> = { "1": ["t2", "t3"], "2": ["t1"] }
		const { records, sent } = recordsOver((_method, _path, options) => {
			const page = String(options.query?.["page"] ?? 1)
			return { body: { has_more: page === "1", items: (pages[page] ?? []).map((id) => ({ id })) }, status: 200 }
		})
		expect(await records.gone(TOKEN)).toBe(false)
		pages["2"] = ["t4"]
		expect(await records.gone(TOKEN)).toBe(true)
		expect(sent.map(({ path }) => path)).toEqual(Array.from({ length: 4 }, () => "/orgs/o1/tokens"))
	})

	it("is never gone from a list that did not show its end: one page of an unpaged list, or a page served again", async () => {
		/* w1 is live beyond the one page served; nothing says that page was the whole list. */
		const widgets = recordsOver(() => ({ body: [{ id: "w2" }], status: 200 }))
		expect(await widgets.records.gone(recordOf("widgets.delete", { widget_id: "w1" }))).toBe(false)
		const repeating = recordsOver(() => ({ body: { has_more: true, items: [{ id: "t2" }] }, status: 200 }))
		expect(await repeating.records.gone(TOKEN)).toBe(false)
		expect(repeating.sent).toHaveLength(2)
	})

	it("is gone from a list whose first page is empty", async () => {
		const { records } = recordsOver(() => ({ body: [], status: 200 }))
		expect(await records.gone(recordOf("widgets.delete", { widget_id: "w1" }))).toBe(true)
	})

	it("claims nothing when its list cannot be read", async () => {
		const { records } = recordsOver(() => ({ status: 500 }))
		expect(await records.gone(TOKEN)).toBe(false)
	})
})
