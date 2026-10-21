import { describe, expect, it } from "vitest"
import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"
import type { CredentialKey } from "../../credentials/store-types.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { modelOf } from "../checks/__fixtures__/harness.ts"
import { floorCredentials } from "./floor-credentials.ts"
import type { RunContext } from "./context.ts"

/*
 * The floor's credential operations are what the recipes name, and the floor sends one with a
 * dedicated credential of the principal's, never the principal's own session.
 */

const ok = { "200": { description: "ok" } }
const post = (operationId: string, security?: unknown[]) => ({
	post: { operationId, responses: ok, ...(security === undefined ? {} : { security }) },
})

const DOCUMENT = {
	components: {
		securitySchemes: {
			bearer: { scheme: "bearer", type: "http" },
			key: { in: "header", name: "x-key", type: "apiKey" },
		},
	},
	info: { title: "floor", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/login": post("auth.login", []),
		"/login/verify": post("auth.verify", []),
		"/refresh": post("auth.refresh", []),
		"/logout": post("auth.logout"),
		"/keys": post("keys.create"),
		"/keys/revoke": post("keys.revoke"),
		"/either": post("either.call", [{ bearer: [] }, { key: [] }]),
		"/both": post("both.call", [{ bearer: [], key: [] }]),
		"/notes": post("notes.create", [{ bearer: ["notes:write"] }]),
	},
	security: [{ bearer: [] }],
} as unknown as OpenApiDocument

const SECURITY: SecurityConfig = {
	bearer: {
		login: {
			from: "$.token",
			revoke: { body: { token: "{credential}" }, operationId: "auth.logout" },
			steps: [
				{
					body: {
						email: "{principal.email}",
						password: "secret-{principal.password}",
						profile: { handle: "{principal.handle}", locale: "en" },
						remember: true,
					},
					operationId: "auth.login",
				},
				{ operationId: "auth.verify" },
			],
		},
		refresh: {
			from: "$.token",
			steps: [
				{ body: { token: "{credential}" }, operationId: "auth.refresh" },
				{ body: "grant=refresh&client={principal.id}", operationId: "auth.refresh" },
			],
		},
	},
	key: { mint: { from: "$.key", operationId: "keys.create", revoke: "keys.revoke", with: "bearer" } },
}

/* Beta signs in through a raw step at the verify route, and a step at another origin. */
const PRINCIPALS: PrincipalsConfig = {
	alpha: {},
	beta: {
		security: {
			bearer: {
				login: {
					from: "$.token",
					steps: [
						{ body: { user: "{principal.id}" }, method: "POST", path: "/login/verify" },
						{ operationId: "sso.login", origin: "sso" },
					],
				},
			},
		},
	},
}

/** A floor context whose store issues a dedicated credential for each scheme `blocked` does not name; `null` configures no security. */
function contextOf(blocked: Record<string, string> = {}, security: SecurityConfig | null = SECURITY) {
	const asked: CredentialKey[] = []
	const store = {
		acquireDedicated: async (key: CredentialKey) => {
			asked.push(key)
			const reason = blocked[key.scheme]
			if (reason !== undefined) return { blocked: reason }
			return {
				credential: { value: "v" },
				owner: key.principal,
				principal: `${key.principal}#probe-1`,
				scheme: key.scheme,
			}
		},
		principals: PRINCIPALS,
	}
	const options = security === null ? {} : { security }
	const ctx = { model: modelOf(DOCUMENT), options, store } as unknown as RunContext
	return { asked, credentials: floorCredentials(ctx, "alpha"), model: ctx.model }
}

const op = (model: RunContext["model"], operationId: string) => {
	const found = model.byOperationId.get(operationId)
	if (found === undefined) throw new Error(`no ${operationId}`)
	return found
}

describe("floorCredentials: which operations", () => {
	it("names every operation a principal's recipe names: its steps, refresh, revokes and mint", () => {
		const { credentials } = contextOf()
		expect([...credentials.operations].sort()).toEqual([
			"auth.login",
			"auth.logout",
			"auth.refresh",
			"auth.verify",
			"keys.create",
			"keys.revoke",
		])
		expect(contextOf({}, null).credentials.operations.size).toBe(0)
	})
})

describe("floorCredentials: which body fields name the principal", () => {
	it("maps each sign-in step's operation to the fields it fills from the principal, and nothing else", () => {
		const { credentials } = contextOf()
		expect(Object.fromEntries(credentials.identityFields)).toEqual({
			"auth.login": [["email"], ["password"], ["profile", "handle"]],
			"auth.verify": [["user"]],
		})
		expect(contextOf({}, null).credentials.identityFields.size).toBe(0)
	})
})

describe("floorCredentials: who sends one", () => {
	it("sends nobody where the operation admits it, else a dedicated credential with its scopes", async () => {
		const { asked, credentials, model } = contextOf()
		expect(await credentials.actorFor(op(model, "auth.refresh"))).toEqual({ as: { anonymous: true } })
		expect(await credentials.actorFor(op(model, "notes.create"))).toEqual({
			as: { principal: "alpha#probe-1", scheme: "bearer" },
		})
		expect(asked).toEqual([{ principal: "alpha", scheme: "bearer", scopes: ["notes:write"] }])
	})

	it("tries each alternative in turn, and leaves it untested with every reason when none can be had", async () => {
		const either = contextOf({ bearer: "static recipes cannot issue a dedicated credential" })
		expect(await either.credentials.actorFor(op(either.model, "either.call"))).toEqual({
			as: { principal: "alpha#probe-1", scheme: "key" },
		})
		const none = contextOf({ bearer: "static recipes cannot issue a dedicated credential", key: "BLOCKED" })
		expect(await none.credentials.actorFor(op(none.model, "either.call"))).toEqual({
			untested:
				"a credential operation is sent with a dedicated credential, never alpha's own session, and none could be had: " +
				"bearer: static recipes cannot issue a dedicated credential; key: BLOCKED",
		})
		expect(await none.credentials.actorFor(op(none.model, "both.call"))).toEqual({
			untested:
				"a credential operation is sent with a dedicated credential, never alpha's own session, and none could be had: " +
				"bearer + key: a dedicated credential holds one scheme",
		})
	})
})
