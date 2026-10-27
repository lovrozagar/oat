import { describe, expect, it } from "vitest"
import type { PrincipalsConfig, SecurityConfig } from "../config/types/security.ts"
import { sendsFor } from "../credentials/placement.ts"
import type { CredentialKey, Held } from "../credentials/store.ts"
import { buildModel } from "../spec/graph/build.ts"
import { anyrow, cloudflare } from "../spec/security/__fixtures__/documents.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import type { SecurityScheme } from "../spec/security/schemes.ts"
import type { Exchange } from "../runtime/exchange.ts"
import type { Resolution, Sending } from "./credential-source.ts"
import { type CredentialStorePort, createCredentialSource } from "./credentials.ts"

/* A store that issues `<principal>-<scheme>-<n>` per renewal and records every call. */
function fakeStore(
	model: Pick<ReturnType<typeof buildModel>, "schemes">,
	security: SecurityConfig,
	blocked: Set<string> = new Set(),
) {
	const calls: string[] = []
	const issued = new Map<string, number>()
	const held = (key: CredentialKey): Held => {
		if (blocked.has(key.scheme)) return { blocked: `could not acquire ${key.scheme}` }
		const n = issued.get(key.scheme) ?? 1
		const value = `${key.principal}-${key.scheme}-${n}`
		const spec = model.schemes.get(key.scheme)
		if (spec === undefined) throw new Error(`the test asked for ${key.scheme}`)
		return { expiresAt: null, value, ...sendsFor(spec, security[key.scheme] ?? {}, value) }
	}
	const store: CredentialStorePort = {
		acquire: async (key) => {
			calls.push(`acquire ${key.principal} ${key.scheme} [${(key.scopes ?? []).join(",")}]`)
			return held(key)
		},
		block: (key, reason) => {
			calls.push(`block ${key.principal} ${key.scheme}: ${reason}`)
		},
		refresh: async (request) => {
			calls.push(`refresh ${request.principal} ${request.scheme} ${request.sentValue}`)
			issued.set(request.scheme, (issued.get(request.scheme) ?? 1) + 1)
			if (request.scheme === "apiKey") blocked.add("apiKey")
			return held(request)
		},
	}
	return { calls, store }
}

const security: SecurityConfig = {
	apiKey: { format: "ApiKey {credential}", holds: ["rows:read"], static: "key_alpha" },
	jwt: { from: "$.token", login: { from: "$.token", steps: [{ operationId: "auth.login" }] } } as never,
}
const principals: PrincipalsConfig = {
	alpha: {},
	machine: { security: { jwt: { format: "{credential}" } } },
}

function sourceOf(more: { security?: SecurityConfig; principals?: PrincipalsConfig; blocked?: Set<string> } = {}) {
	const model = buildModel(anyrow)
	const config = more.security ?? security
	const { calls, store } = fakeStore(model, config, more.blocked)
	const source = createCredentialSource({ model, principals: more.principals ?? principals, security: config, store })
	return { calls, source }
}

const ROUTE = "GET /rows"

const sending = (resolution: Resolution): Sending => {
	if (resolution.kind !== "sends") throw new Error(`expected sends, got ${resolution.kind}`)
	return resolution
}

describe("createCredentialSource: alternatives", () => {
	it("sends the first alternative the principal can satisfy, with its scopes", async () => {
		const { calls, source } = sourceOf()
		const jwt = sending(await source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "row.list" }))
		expect(jwt).toMatchObject({ principal: "alpha", schemes: ["jwt"], sentValues: { jwt: "alpha-jwt-1" } })
		expect(jwt.sends).toEqual({ jwt: { cookies: {}, headers: { Authorization: "Bearer alpha-jwt-1" }, query: {} } })
		expect(jwt.secrets).toEqual({ cookies: [], headers: ["Authorization"], query: [], values: ["alpha-jwt-1"] })
		const keyOnly = sourceOf({ security: { apiKey: security["apiKey"] } as SecurityConfig })
		const key = sending(
			await keyOnly.source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "row.list" }),
		)
		expect(key.sends).toEqual({
			apiKey: { cookies: {}, headers: { Authorization: "ApiKey alpha-apiKey-1" }, query: {} },
		})
		expect(calls).toEqual(["acquire alpha jwt []"])
		expect(keyOnly.calls).toEqual(["acquire alpha apiKey [rows:read]"])
	})

	it("sends every scheme of an AND alternative, under one principal", async () => {
		const model = buildModel(cloudflare)
		const pair = { api_email: { static: "a@b.c" }, api_key: { static: "k" } } as SecurityConfig
		const { store } = fakeStore(model, pair)
		const source = createCredentialSource({ model, principals: { alpha: {} }, security: pair, store })
		const both = sending(
			await source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "zones.list" }),
		)
		expect(both.schemes).toEqual(["api_email", "api_key"])
		expect(Object.keys(both.sends)).toEqual(["api_email", "api_key"])
		expect(both.secrets.headers).toEqual(["X-Auth-Email", "X-Auth-Key"])
	})

	it("reads a principal's own override as its recipe", async () => {
		const { source } = sourceOf({ security: { apiKey: security["apiKey"] } as SecurityConfig })
		const override = { machine: { security: { jwt: { static: "m" } } } } as PrincipalsConfig
		const own = sourceOf({ principals: override, security: { apiKey: security["apiKey"] } as SecurityConfig })
		const request = { actor: { principal: "machine" }, operationId: "row.list" }
		expect(sending(await source.resolve({ route: ROUTE, ...request, actor: { principal: "alpha" } })).schemes).toEqual([
			"apiKey",
		])
		expect(sending(await own.source.resolve({ route: ROUTE, ...request })).schemes).toEqual(["jwt"])
	})
})

describe("createCredentialSource: nothing to send", () => {
	it("sends nothing for an anonymous actor or operation", async () => {
		const { calls, source } = sourceOf()
		const anonymous = { kind: "anonymous" }
		expect(await source.resolve({ actor: { anonymous: true }, operationId: "row.list", route: ROUTE })).toEqual(
			anonymous,
		)
		const login = { actor: { principal: "alpha" }, operationId: "auth.login", route: ROUTE }
		expect(await source.resolve(login)).toEqual(anonymous)
		expect(calls).toEqual([])
	})

	it("refuses a principal's request that matches no documented operation and names no scheme", async () => {
		const { calls, source } = sourceOf()
		const unmatched = {
			kind: "unsatisfied",
			reason: "no documented operation matches GET /jobs/1: name its scheme with as: { principal, scheme }",
		}
		const route = "GET /jobs/1"
		expect(await source.resolve({ actor: { principal: "alpha" }, route })).toEqual(unmatched)
		expect(await source.resolve({ actor: { principal: "alpha" }, operationId: "nope", route })).toEqual(unmatched)
		expect(calls).toEqual([])
	})

	it("names what it cannot satisfy, and what the store blocked", async () => {
		const none = sourceOf({ security: {} })
		const unsatisfied = { kind: "unsatisfied", reason: "no credential for jwt; no credential for apiKey" }
		expect(await none.source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "row.list" })).toEqual(
			unsatisfied,
		)
		const { source } = sourceOf({ blocked: new Set(["jwt"]) })
		const blocked = { kind: "blocked", reason: "could not acquire jwt" }
		expect(await source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "row.list" })).toEqual(
			blocked,
		)
	})
})

describe("createCredentialSource: a named scheme", () => {
	it("sends the named scheme, with the scopes the operation asks of it", async () => {
		const { calls, source } = sourceOf()
		const named = { principal: "alpha", scheme: "apiKey" }
		expect(sending(await source.resolve({ route: ROUTE, actor: named, operationId: "row.list" })).schemes).toEqual([
			"apiKey",
		])
		expect(sending(await source.resolve({ route: ROUTE, actor: named })).schemes).toEqual(["apiKey"])
		expect(calls).toEqual(["acquire alpha apiKey [rows:read]", "acquire alpha apiKey []"])
	})

	it("cannot send a scheme the principal has no recipe for", async () => {
		const { source } = sourceOf({ security: {} })
		const resolution = await source.resolve({ route: ROUTE, actor: { principal: "alpha", scheme: "jwt" } })
		expect(resolution).toEqual({ kind: "unsatisfied", reason: "no credential for jwt" })
	})
})

describe("createCredentialSource: a continuation", () => {
	const keyed = { operationId: "row.list", schemes: ["apiKey"] } as Exchange
	const both = { apiKey: security["apiKey"], jwt: { static: "j" } } as SecurityConfig

	it("resolves a followed URL against the operation it matches", async () => {
		const { calls, source } = sourceOf({ security: both })
		const via = { principal: "alpha", via: keyed }
		const next = sending(await source.resolve({ actor: via, operationId: "row.list", route: ROUTE }))
		expect(next.schemes).toEqual(["jwt"])
		expect(calls).toEqual(["acquire alpha jwt []"])
	})

	it("reuses the originating schemes for a URL no operation matches, with that operation's scopes", async () => {
		const { calls, source } = sourceOf({ security: both })
		const poll = sending(await source.resolve({ actor: { principal: "alpha", via: keyed }, route: "GET /jobs/1" }))
		expect(poll).toMatchObject({ principal: "alpha", schemes: ["apiKey"] })
		const unknown = { schemes: ["jwt"] } as Exchange
		await source.resolve({ actor: { principal: "alpha", via: unknown }, route: "GET /jobs/1" })
		const gone = { operationId: "gone", schemes: ["jwt"] } as Exchange
		await source.resolve({ actor: { principal: "alpha", via: gone }, route: "GET /jobs/1" })
		expect(calls).toEqual(["acquire alpha apiKey [rows:read]", "acquire alpha jwt []", "acquire alpha jwt []"])
	})

	it("sends nothing after an exchange that carried no credential", async () => {
		const { calls, source } = sourceOf()
		const open = { operationId: "auth.login" } as Exchange
		const after = await source.resolve({ actor: { principal: "alpha", via: open }, route: "GET /jobs/1" })
		expect(after).toEqual({ kind: "anonymous" })
		expect(calls).toEqual([])
	})
})

describe("createCredentialSource: refresh", () => {
	it("renews each scheme it sent, naming the value it carried", async () => {
		const { calls, source } = sourceOf()
		const first = sending(
			await source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "row.list" }),
		)
		const renewed = sending(await first.refresh())
		expect(renewed.sentValues).toEqual({ jwt: "alpha-jwt-2" })
		expect(sending(await renewed.refresh()).sentValues).toEqual({ jwt: "alpha-jwt-3" })
		expect(calls.slice(1)).toEqual(["refresh alpha jwt alpha-jwt-1", "refresh alpha jwt alpha-jwt-2"])
	})

	it("blocks every scheme it sent, by the store's own scheme, with the reason", async () => {
		const { calls, source } = sourceOf()
		const first = sending(
			await source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "row.list" }),
		)
		first.block("refused where the old one was accepted")
		expect(calls.slice(1)).toEqual(["block alpha jwt: refused where the old one was accepted"])
	})

	it("is blocked when the renewal fails", async () => {
		const { source } = sourceOf()
		const key = sending(await source.resolve({ route: ROUTE, actor: { principal: "alpha", scheme: "apiKey" } }))
		expect(await key.refresh()).toEqual({ kind: "blocked", reason: "could not acquire apiKey" })
	})
})

describe("createCredentialSource: a held value, sent as given", () => {
	it("places it as the principal's own credential, its secrets named, and asks the store nothing", async () => {
		const { calls, source } = sourceOf()
		const actor = { principal: "alpha", scheme: "apiKey", value: "session-1" }
		expect(await source.resolve({ route: ROUTE, actor })).toEqual({
			kind: "held",
			principal: "alpha",
			schemes: ["apiKey"],
			secrets: expect.objectContaining({ headers: ["Authorization"], values: expect.arrayContaining(["session-1"]) }),
			sends: { apiKey: { cookies: {}, headers: { Authorization: "ApiKey session-1" }, query: {} } },
		})
		const unknown = await source.resolve({ route: ROUTE, actor: { ...actor, scheme: "nope" } })
		expect(unknown).toEqual({ kind: "unsatisfied", reason: 'the document declares no "nope" scheme' })
		expect(calls).toEqual([])
	})
})

describe("createCredentialSource: forged", () => {
	it("places a forged value exactly like the scheme's credential, under the config's format", async () => {
		const { calls, source } = sourceOf()
		const forged = await source.resolve({ route: ROUTE, actor: { forged: { scheme: "apiKey", value: "forged-1" } } })
		expect(forged).toEqual({
			kind: "forged",
			schemes: ["apiKey"],
			sends: { apiKey: { cookies: {}, headers: { Authorization: "ApiKey forged-1" }, query: {} } },
		})
		const bare = sourceOf({ security: {} })
		const jwt = await bare.source.resolve({ route: ROUTE, actor: { forged: { scheme: "jwt", value: "f" } } })
		expect(jwt).toMatchObject({ sends: { jwt: { headers: { Authorization: "Bearer f" } } } })
		expect(calls).toEqual([])
	})

	it("names what a derived value places as secrets, and a garbage one as none", async () => {
		const { source } = sourceOf()
		const derived = { forged: { derived: true, scheme: "apiKey", value: "derived-1" } } as const
		expect(await source.resolve({ route: ROUTE, actor: derived })).toMatchObject({
			kind: "forged",
			secrets: { headers: ["Authorization"], values: expect.arrayContaining(["derived-1"]) },
		})
		const garbage = await source.resolve({ route: ROUTE, actor: { forged: { scheme: "apiKey", value: "x" } } })
		expect(garbage).not.toHaveProperty("secrets")
	})

	it("cannot forge a scheme the document does not declare, or one oat cannot send", async () => {
		const { source } = sourceOf()
		const unknown = await source.resolve({ route: ROUTE, actor: { forged: { scheme: "nope", value: "f" } } })
		expect(unknown).toEqual({ kind: "unsatisfied", reason: 'the document declares no "nope" scheme' })
		const mtls = { ...anyrow, components: { securitySchemes: { tls: { type: "mutualTLS" } } } } as OpenApiDocument
		const model = buildModel(mtls)
		const tls = createCredentialSource({ model, principals, security: {}, store: fakeStore(model, {}).store })
		const refused = await tls.resolve({ route: ROUTE, actor: { forged: { scheme: "tls", value: "f" } } })
		expect(refused).toMatchObject({
			kind: "unsatisfied",
			reason: expect.stringMatching(/cannot send the "tls" scheme/),
		})
	})
})

describe("createCredentialSource: a dedicated credential's probe principal", () => {
	it("acquires under the probe principal, and names the principal it was made for as the sender", async () => {
		const { calls, source } = sourceOf({ principals: { ...principals, "alpha#probe-1": {} } })
		const sent = sending(
			await source.resolve({ route: ROUTE, actor: { principal: "alpha#probe-1", scheme: "apiKey" } }),
		)
		expect(sent.principal).toBe("alpha")
		expect(calls).toEqual(["acquire alpha#probe-1 apiKey []"])
	})
})

/* A secondary origin's document: fileKey and other declared, ghost only named. */
const files = {
	components: {
		securitySchemes: {
			fileKey: { in: "query", name: "k", type: "apiKey" },
			other: { scheme: "bearer", type: "http" },
		},
	},
	info: { title: "files", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/files": { get: { operationId: "file.list", responses: {}, security: [{ fileKey: [] }] } },
		"/ghost": { get: { operationId: "ghost.list", responses: {}, security: [{ ghost: [] }] } },
		"/other": { get: { operationId: "other.list", responses: {}, security: [{ other: [] }] } },
	},
} as unknown as OpenApiDocument

/* The origin's adapter, mapping fileKey and ghost to the primary's jwt. */
function originSource() {
	const { calls, store } = fakeStore(buildModel(anyrow), security)
	const model = buildModel(files)
	const mapping = { fileKey: "jwt", ghost: "jwt" }
	return { calls, source: createCredentialSource({ mapping, model, principals, security, store }) }
}

describe("createCredentialSource: a secondary origin", () => {
	it("sends the mapped primary credential, placed where the origin's scheme puts it", async () => {
		const { calls, source } = originSource()
		const placed = sending(
			await source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "file.list" }),
		)
		expect(placed).toMatchObject({ schemes: ["fileKey"], sentValues: { fileKey: "alpha-jwt-1" } })
		expect(placed.sends).toEqual({ fileKey: { cookies: {}, headers: {}, query: { k: "alpha-jwt-1" } } })
		expect(placed.secrets).toEqual({ cookies: [], headers: [], query: ["k"], values: ["alpha-jwt-1"] })
		expect(sending(await placed.refresh()).sends).toEqual({
			fileKey: { cookies: {}, headers: {}, query: { k: "alpha-jwt-2" } },
		})
		expect(calls).toEqual(["acquire alpha jwt []", "refresh alpha jwt alpha-jwt-1"])
	})

	it("sends nothing for an origin scheme the config does not map", async () => {
		const { source } = originSource()
		const resolution = await source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "other.list" })
		expect(resolution).toEqual({ kind: "unsatisfied", reason: "no credential for other" })
		const forged = await source.resolve({ route: ROUTE, actor: { forged: { scheme: "fileKey", value: "f" } } })
		expect(forged).toMatchObject({ sends: { fileKey: { query: { k: "f" } } } })
	})

	it("cannot place a mapped credential under a scheme the origin's document does not declare", async () => {
		const { source } = originSource()
		const resolution = await source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "ghost.list" })
		expect(resolution).toEqual({ kind: "unsatisfied", reason: 'the document declares no "ghost" scheme' })
	})
})

describe("createCredentialSource: a recipe only an origin's scheme is for", () => {
	it("places a recipe only the origin's scheme is for in that recipe's own format", async () => {
		const model = buildModel(files)
		const ownSecurity: SecurityConfig = { fileToken: { format: "Token {credential}", static: "s" } }
		const { store } = fakeStore(
			{ schemes: new Map([["fileToken", model.schemes.get("other") as SecurityScheme]]) },
			ownSecurity,
		)
		const source = createCredentialSource({
			mapping: { other: "fileToken" },
			model,
			originOnly: new Set(["fileToken"]),
			principals,
			security: ownSecurity,
			store,
		})
		const placed = sending(
			await source.resolve({ route: ROUTE, actor: { principal: "alpha" }, operationId: "other.list" }),
		)
		expect(placed.sends["other"]?.headers).toEqual({ Authorization: "Token alpha-fileToken-1" })
	})
})
