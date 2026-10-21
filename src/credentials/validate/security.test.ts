import { describe, expect, it } from "vitest"
import { anyrow, cloudflare, immich, keycloak } from "../../spec/security/__fixtures__/documents.ts"
import { buildModel } from "../../spec/graph/build.ts"
import { UsageError } from "../../errors/usage-error.ts"
import { assertSecurity, securityMapProblems, securityProblems, specView, type SpecView } from "./security.ts"

const view = (doc: typeof anyrow): SpecView => {
	const model = buildModel(doc)
	return { authFlows: false, operations: model.operations, schemes: model.schemes }
}

const ANYROW = view(anyrow)
const login = { from: "$.token", steps: [{ body: { email: "{principal.email}" }, operationId: "auth.login" }] }
const alpha = { email: "a@x.test", tenant: "t1" }

/* The problems one config has against anyrow's document. */
const problems = (config: Record<string, unknown>, spec: SpecView = ANYROW, origins = {}): string[] =>
	securityProblems({ principals: { alpha }, security: { jwt: { login } }, ...config }, spec, origins)

const mintWith = (withScheme: string) => ({ from: "$.k", operationId: "row.list", with: withScheme })
const jwtWith = (extra: Record<string, unknown>) => ({ security: { jwt: { login, ...extra } } })

describe("security recipes", () => {
	it("accept one recipe per declared scheme", () => {
		const security = {
			apiKey: {
				format: "ApiKey {credential}",
				mint: { body: { scopes: "{scopes}" }, from: "$.key", operationId: "row.list", with: "jwt" },
			},
			jwt: { expiresIn: { from: "$.expires_in" }, login },
		}
		expect(problems({ security })).toEqual([])
	})

	it("name an unknown scheme, the nearest one and every scheme the document declares", () => {
		expect(problems({ security: { jtw: { login } } })).toEqual([
			'security.jtw names no scheme in the document. Did you mean "jwt"? The document declares: apiKey, jwt',
		])
	})

	it("need exactly one recipe kind", () => {
		expect(problems({ security: { jwt: {} } })).toEqual([
			"security.jwt needs exactly one of login, mint, static, hook, oauth2",
		])
		expect(problems({ security: { jwt: { login, static: "t" } } })).toEqual([
			"security.jwt has login and static; keep exactly one",
		])
	})

	it("refuse a mint whose `with` names no recipe, or that mints itself in a loop", () => {
		expect(problems({ security: { apiKey: { mint: mintWith("nope") }, jwt: { login } } })).toEqual([
			'security.apiKey.mint.with names "nope", which has no recipe',
		])
		expect(problems({ security: { apiKey: { mint: mintWith("jwt") }, jwt: { mint: mintWith("apiKey") } } })).toEqual([
			"security.apiKey.mint.with forms a loop: apiKey → jwt → apiKey",
			"security.jwt.mint.with forms a loop: jwt → apiKey → jwt",
		])
	})

	it("refuse a mint calling an operation the document lacks, or asking {scopes} no operation needs", () => {
		const mint = { body: { scopes: "{scopes}" }, from: "$.k", operationId: "row.lsit", with: "jwt" }
		expect(problems({ security: { apiKey: { mint }, jwt: { login } } })).toEqual([
			'security.apiKey.mint.operationId "row.lsit" names no operation',
		])
		const unscoped = { ...mint, operationId: "asset.list", with: "bearer" }
		expect(problems({ security: { api_key: { mint: unscoped }, bearer: { static: "t" } } }, view(immich))).toEqual([
			"security.api_key.mint.body asks for {scopes}, but no operation needs api_key with scopes",
		])
	})
})

describe("security mints and hooks", () => {
	it("refuse a mint whose revoke names no operation", () => {
		const mint = { ...mintWith("jwt"), revoke: "row.revoek" }
		expect(problems({ security: { apiKey: { mint }, jwt: { login } } })).toEqual([
			'security.apiKey.mint.revoke "row.revoek" names no operation',
		])
		expect(problems({ security: { apiKey: { mint: { ...mint, revoke: "row.list" } }, jwt: { login } } })).toEqual([])
	})

	it("refuse a login whose revoke names no operation, as a mint's", () => {
		expect(problems(jwtWith({ login: { ...login, revoke: "auth.logot" } }))).toEqual([
			'security.jwt.login.revoke "auth.logot" names no operation',
		])
		expect(problems(jwtWith({ login: { ...login, revoke: "row.list" } }))).toEqual([])
		expect(problems(jwtWith({ login: { ...login, revoke: { operationId: "auth.revok" } } }))).toEqual([
			'security.jwt.login.revoke "auth.revok" names no operation',
		])
	})

	it("leave a mint whose with or operationId is not a string to the shape check", () => {
		const mint = { from: "$.k", operationId: 1, with: 2 }
		expect(problems({ security: { apiKey: { mint }, jwt: { login } } })).toEqual([
			"security.apiKey.mint.operationId must be a string",
			"security.apiKey.mint.with must be a string",
		])
	})

	it("accept a hook recipe when the config has hooks.resolveCredential", () => {
		const hooks = { resolveCredential: () => Promise.resolve("t") }
		expect(problems({ hooks, security: { jwt: { hook: true } } })).toEqual([])
	})
})

describe("security recipe options", () => {
	it("check expiresIn, holds and placements", () => {
		expect(problems(jwtWith({ expiresIn: 0 }))).toEqual([
			"security.jwt.expiresIn must be seconds above 0 or { from: <json path> }",
		])
		expect(problems(jwtWith({ expiresIn: { from: 3 } }))).toEqual([
			"security.jwt.expiresIn must be seconds above 0 or { from: <json path> }",
		])
		expect(problems(jwtWith({ holds: "rows:read" }))).toEqual(["security.jwt.holds must be a list of scope names"])
		expect(problems(jwtWith({ placements: [{ in: "body", name: "k" }] }))).toEqual([
			"security.jwt.placements[0] must be { in: header | query | cookie, name, template? containing {credential} }",
		])
		expect(problems(jwtWith({ placements: [{ in: "query", name: "k", template: "no slot" }] }))).toEqual([
			"security.jwt.placements[0] must be { in: header | query | cookie, name, template? containing {credential} }",
		])
	})

	it("refuse holds on an oauth2 or mint recipe, naming where its scopes come from", () => {
		const oauthDoc = view({
			...keycloak,
			components: {
				securitySchemes: { o: { flows: { clientCredentials: { scopes: { a: "" }, tokenUrl: "/t" } }, type: "oauth2" } },
			},
		})
		const oauth2 = { clientId: "c", flow: "clientCredentials", scopes: ["a"] }
		expect(problems({ security: { o: { holds: ["a"], oauth2 } } }, oauthDoc)).toEqual([
			"security.o.holds is not for an oauth2 recipe: it holds the oauth2.scopes it asks for",
		])
		expect(
			problems(
				{ security: { o: { oauth2: { ...oauth2, flow: "password", password: "p", username: "u" } } } },
				oauthDoc,
			),
		).toEqual(['security.o.oauth2.flow "password" is not a flow scheme o declares with a tokenUrl'])
		expect(problems({ security: { jwt: { oauth2 } } })).toEqual([
			"security.jwt.oauth2 needs an oauth2 scheme; jwt is bearer",
		])
	})

	it("refuse a recipe for a scheme oat cannot send", () => {
		const mtls = view({ ...keycloak, components: { securitySchemes: { m: { type: "mutualTLS" } } } })
		expect(problems({ security: { m: { static: "x" } } }, mtls)).toEqual([
			"security.m: mutualTLS is a TLS client certificate, not a request credential",
		])
	})
})

describe("principals", () => {
	it("are a map of id to identity data", () => {
		expect(problems({ principals: [{ id: "alpha" }] })).toEqual([
			"principals is a map of id → identity data now: { alpha: { email: …, tenant: … } }",
		])
		expect(problems({ principals: { alpha: "x" } })).toEqual(["principals.alpha must be an object of identity data"])
		expect(problems({ principals: {} })).toEqual(["principals declares no principal"])
	})

	it("check tenant, rank, inviteAs, fresh and per-scheme overrides", () => {
		const bad = { ...alpha, fresh: "yes", inviteAs: 1, rank: 1.5, security: { nope: { static: "x" } }, tenant: 2 }
		expect(problems({ principals: { alpha: bad } })).toEqual([
			"principals.alpha.fresh must be true or false",
			"principals.alpha.inviteAs must be a string",
			"principals.alpha.rank must be an integer",
			"principals.alpha.security.nope names no scheme in the document. The document declares: apiKey, jwt",
			"principals.alpha.tenant must be a string",
		])
	})

	it("must supply every {principal.<key>} a recipe uses, unless they override that recipe", () => {
		const beta = { tenant: "t2" }
		expect(problems({ principals: { alpha, beta } })).toEqual([
			'principals.beta has no "email", which security.jwt uses as {principal.email}',
		])
		const overriding = { ...beta, security: { jwt: { static: "token" } } }
		expect(problems({ principals: { alpha, beta: overriding } })).toEqual([])
	})
})

describe("what 0.25.0 removed", () => {
	it("names the replacement for each removed field and tag", () => {
		const old = { principals: { alpha: { ...alpha, auth: {}, headers: {}, roots: {} } }, rootsFromFlow: {} }
		expect(problems(old)).toEqual([
			"principals.alpha.auth was removed in 0.25.0: put the flow in security.<scheme>: { login: { steps, from } }",
			"principals.alpha.headers was removed in 0.25.0: a fixed credential is security.<scheme>: { static: … }",
			"principals.alpha.roots was removed in 0.25.0: bind its parameters with principals.alpha.scope and its tenant with tenant",
			"rootsFromFlow was removed in 0.25.0: bind token claims with security.<scheme>.login.claims",
		])
		expect(problems({}, { ...ANYROW, authFlows: true })).toEqual([
			"the document's x-auth-flows tag is no longer read: declare a security.<scheme> recipe in config",
		])
	})
})

describe("secondary origins", () => {
	it("refuse a scheme an origin shares by name with the primary, unless mapped", () => {
		const cdn = view(anyrow)
		expect(problems({}, ANYROW, { cdn })).toEqual([
			'origins.cdn declares scheme "jwt" too; say which recipe it uses: origins[].security: { jwt: "jwt" }',
		])
		expect(problems({ origins: [{ id: "cdn", security: { jwt: "jwt" } }] }, ANYROW, { cdn })).toEqual([])
	})
})

describe("security, at the edges", () => {
	it("refuse holds on a mint recipe, and placements that are not a list", () => {
		const mint = { from: "$.k", holds: ["a"], operationId: "row.list", with: "jwt" }
		expect(problems({ security: { apiKey: { holds: ["a"], mint }, jwt: { login } } })).toEqual([
			"security.apiKey.holds is not for a mint recipe: it holds the scopes its body asks for",
		])
		expect(problems({ security: { jwt: { login, placements: {} } } })).toEqual([
			"security.jwt.placements must be a list",
		])
		const placements = [
			{ in: "query", name: "k" },
			{ in: "cookie", name: "c", template: "v={credential}" },
		]
		expect(problems({ security: { jwt: { login, placements } } })).toEqual([])
	})

	it("name an unknown scheme with nothing close, a recipe that is not an object, and a security that is not a map", () => {
		expect(problems({ security: { completelyelsewhere: { login } } })).toEqual([
			"security.completelyelsewhere names no scheme in the document. The document declares: apiKey, jwt",
		])
		expect(problems({ security: { jwt: "token" } })).toEqual(["security.jwt must be a recipe object"])
		expect(problems({ security: "jwt" })).toEqual(["security must be a map of scheme → recipe"])
	})
})

const beta = (security: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
	principals: { alpha, beta: { tenant: "t2", ...extra, security } },
})

describe("principal overrides, on the effective recipe", () => {
	it("check an override that only merges options, and the placeholders it inherits", () => {
		expect(problems(beta({ jwt: { format: "Token {credential}" } }))).toEqual([
			'principals.beta has no "email", which security.jwt uses as {principal.email}',
		])
		expect(problems(beta({ jwt: { expiresIn: 0 } }, { email: "b@x.test" }))).toEqual([
			"principals.beta.security.jwt.expiresIn must be seconds above 0 or { from: <json path> }",
		])
	})

	it("let an override that names a kind replace the base kind, and check what it becomes", () => {
		expect(problems(beta({ jwt: { static: "token" } }))).toEqual([])
		expect(problems(beta({ jwt: { hook: true, static: "token" } }))).toEqual([
			"principals.beta.security.jwt has static and hook; keep exactly one",
		])
		expect(problems(beta({ jwt: { static: { password: "p", username: "u" } } }))).toEqual([
			"principals.beta.security.jwt.static must be a string for a bearer scheme",
		])
	})

	it("check an override for a scheme with no base recipe as a whole recipe", () => {
		expect(problems(beta({ apiKey: { format: "ApiKey {credential}" } }, { email: "b@x.test" }))).toEqual([
			"principals.beta.security.apiKey needs exactly one of login, mint, static, hook, oauth2",
		])
	})
})

describe("specView", () => {
	it("reads the schemes and operations from the model, and whether the document still has x-auth-flows", () => {
		const model = buildModel(anyrow)
		expect(specView(model, anyrow)).toEqual({ authFlows: false, operations: model.operations, schemes: model.schemes })
		expect(specView(model, { ...anyrow, "x-auth-flows": {} }).authFlows).toBe(true)
	})

	it("holds a scenario step to a scheme its document declares", () => {
		const scenarios = [{ covers: [], id: "s1", steps: [{ operationId: "row.list", scheme: "jtw" }] }]
		expect(problems({ scenarios })).toContain(
			'scenarios.s1.steps[0].scheme "jtw" names no scheme in the document. Did you mean "jwt"? The document declares: apiKey, jwt',
		)
	})

	it("reads the x-fresh-principal operation and the properties its request body names", () => {
		const signup = {
			post: {
				operationId: "auth.signup",
				requestBody: {
					content: { "application/json": { schema: { properties: { email: {}, password: {} }, type: "object" } } },
				},
				responses: { "201": { description: "made" } },
				security: [],
				"x-fresh-principal": true,
			},
		}
		const bare = { post: { ...signup.post, operationId: "auth.bare", requestBody: undefined } }
		const doc = { ...anyrow, paths: { ...anyrow.paths, "/v1/signup": signup } } as typeof anyrow
		expect(specView(buildModel(doc), doc).fresh).toEqual({
			operationId: "auth.signup",
			properties: ["email", "password"],
		})
		const empty = { ...anyrow, paths: { ...anyrow.paths, "/v1/bare": bare } } as typeof anyrow
		expect(specView(buildModel(empty), empty).fresh).toEqual({ operationId: "auth.bare", properties: [] })
		const fresh = { email: "f@x.test", fresh: true }
		expect(problems({ principals: { alpha, fresh } })).toContain(
			"principals.fresh is fresh, but the document marks no x-fresh-principal operation to sign it up",
		)
	})
})

describe("globalHeaders, against where credentials go", () => {
	it("refuse a header a declared scheme places its credential in, whatever its case", () => {
		const globalHeaders = { "x-auth-email": "a@x.test", "X-Request-Id": "r" }
		expect(securityProblems({ globalHeaders, principals: { alpha } }, view(cloudflare))).toEqual([
			'globalHeaders.x-auth-email is where scheme "api_email" places its credential; remove it and declare security.api_email',
		])
		expect(problems({ globalHeaders: { authorization: "x" } })).toEqual([
			'globalHeaders.authorization is where scheme "apiKey" places its credential; remove it and declare security.apiKey',
			'globalHeaders.authorization is where scheme "jwt" places its credential; remove it and declare security.jwt',
		])
	})

	it("refuse one an origin's scheme places its credential in, or a recipe's extra placement", () => {
		expect(problems({ globalHeaders: { "X-Auth-Key": "k" } }, ANYROW, { cf: view(cloudflare) })).toEqual([
			'globalHeaders.X-Auth-Key is where origins.cf scheme "api_key" places its credential; remove it and map the scheme with origins[].security',
		])
		const placements = [
			{ in: "query", name: "x-tenant" },
			{ in: "header", name: "X-Tenant", template: "T {credential}" },
		]
		expect(problems({ ...jwtWith({ placements }), globalHeaders: { "x-tenant": "t" } })).toEqual([
			"globalHeaders.x-tenant is where security.jwt.placements[1] places its credential; remove it",
		])
	})
})

describe("securityMapProblems", () => {
	it("checks the map, each recipe's kind and its options, with no document to name schemes", () => {
		expect(securityMapProblems({})).toEqual([])
		expect(securityMapProblems({ security: [] })).toEqual(["security must be a map of scheme → recipe"])
		expect(
			securityMapProblems({ security: { anything: { static: "t" }, jwt: "t", o: { holds: 1, static: "t" } } }),
		).toEqual(["security.jwt must be a recipe object", "security.o.holds must be a list of scope names"])
		expect(securityMapProblems({ security: { jwt: { hook: true, static: "t" } } })).toEqual([
			"security.jwt has static and hook; keep exactly one",
		])
	})
})

describe("assertSecurity", () => {
	const primary = { doc: anyrow, model: buildModel(anyrow) }
	const config = { principals: { alpha }, security: { jwt: { login } } }

	it("passes a config that fits the document and every origin's", () => {
		const cdn = { doc: cloudflare, model: buildModel(cloudflare) }
		expect(() => assertSecurity(config, primary)).not.toThrow()
		expect(() => assertSecurity(config, primary, new Map([["cdn", cdn]]))).not.toThrow()
	})

	it("refuses one that does not, naming every problem on a line of its own", () => {
		expect(() =>
			assertSecurity({ ...config, security: { jtw: { login }, jwt: { login } } }, primary, new Map([["cdn", primary]])),
		).toThrow(
			new UsageError(
				"the config's credentials do not fit the document:\n" +
					'  origins.cdn declares scheme "jwt" too; say which recipe it uses: origins[].security: { jwt: "jwt" }\n' +
					'  security.jtw names no scheme in the document. Did you mean "jwt"? The document declares: apiKey, jwt',
			),
		)
	})
})

describe("a document that declares no security scheme", () => {
	it("says so, for a recipe and for a principal's override", () => {
		const security = { jwt: { static: "t" } }
		expect(securityProblems({ principals: { alpha: { security } }, security }, view(keycloak))).toEqual([
			"principals.alpha.security.jwt names no scheme in the document. The document declares no security scheme",
			"security.jwt names no scheme in the document. The document declares no security scheme",
		])
	})
})
