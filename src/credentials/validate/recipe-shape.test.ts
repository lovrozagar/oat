import { describe, expect, it } from "vitest"
import { anyrow, everyScheme, keycloak } from "../../spec/security/__fixtures__/documents.ts"
import { buildModel } from "../../spec/graph/build.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { securityProblems, type SpecView } from "./security.ts"
import { kindProblems } from "./recipe-shape.ts"

/* Each recipe kind's own shape. A .json or .mjs config skips TypeScript, so this is the only check. */

const view = (doc: OpenApiDocument): SpecView => {
	const model = buildModel(doc)
	return { authFlows: false, operations: model.operations, schemes: model.schemes }
}
const ANYROW = view(anyrow)
const steps = [{ operationId: "auth.login" }]
const principals = { alpha: { tenant: "t1" } }

const problems = (security: Record<string, unknown>, spec: SpecView = ANYROW, extra = {}): string[] =>
	securityProblems({ principals, security, ...extra }, spec)

describe("login and refresh", () => {
	it("need a non-empty list of steps and a path to the credential", () => {
		expect(problems({ jwt: { login: { from: "$.t", steps: [] } } })).toEqual([
			"security.jwt.login.steps must be a non-empty list of steps",
		])
		expect(problems({ jwt: { login: { steps } } })).toEqual(["security.jwt.login.from must be a JSON path string"])
		expect(problems({ jwt: { login: "steps" } })).toEqual([
			"security.jwt.login.from must be a JSON path string",
			"security.jwt.login.steps must be a non-empty list of steps",
		])
		expect(problems({ jwt: { login: { from: "$.t", steps }, refresh: { steps: "x" } } })).toEqual([
			"security.jwt.refresh.from must be a JSON path string",
			"security.jwt.refresh.steps must be a non-empty list of steps",
		])
	})
})

/* A refresh whose one step sends `{name}`. */
const renew = (name: string) => ({
	from: "$.t",
	steps: [{ body: { token: `{${name}}` }, operationId: "auth.login" }],
})

describe("login and refresh placeholders", () => {
	it("name a placeholder that no captured or configured value fills", () => {
		const saving = [{ operationId: "auth.login", saveAs: { refresh_token: "$.r" } }]
		expect(problems({ jwt: { login: { from: "$.t", steps: saving }, refresh: renew("refresh_token") } })).toEqual([])
		expect(problems({ jwt: { login: { from: "$.t", steps: saving }, refresh: renew("credential") } })).toEqual([])
		expect(problems({ jwt: { login: { from: "$.t", steps }, refresh: renew("refresh_token") } })).toEqual([
			"security.jwt.refresh.steps[0] reads {refresh_token}, which neither the login saves nor an earlier refresh step binds",
		])
		expect(problems({ jwt: { login: renew("token") } })).toEqual([
			"security.jwt.login.steps[0] reads {token}, which no earlier login step binds",
		])
	})

	it("leave a refresh to the run where the document signs principals up, as its answer may carry the value", () => {
		const refresh = { from: "$.t", steps: [{ body: { token: "{refresh_token}" }, operationId: "auth.login" }] }
		const signup = { ...ANYROW, fresh: { operationId: "auth.login", properties: [] } }
		expect(problems({ jwt: { login: { from: "$.t", steps }, refresh } }, signup)).toEqual([])
	})

	it("catch the same mistake made through a principal's override", () => {
		const security = { jwt: { login: { from: "$.t", steps } } }
		const refresh = { from: "$.t", steps: [{ body: { token: "{refresh_token}" }, operationId: "auth.login" }] }
		const extra = { principals: { alpha: { security: { jwt: { refresh } }, tenant: "t1" } } }
		expect(problems(security, ANYROW, extra)).toEqual([
			"principals.alpha.security.jwt.refresh.steps[0] reads {refresh_token}, which neither the login saves nor an earlier refresh step binds",
		])
	})
})

const withClaims = (claims: unknown) => ({ jwt: { login: { claims, from: "$.t", steps } } })

describe("login claims", () => {
	it("bind the tenant or a scope parameter from the answer", () => {
		expect(problems(withClaims({ "scope.project_id": "$.project.id", tenant: "org_id" }))).toEqual([])
	})

	it("bind nothing else, and name a claim or path as a string", () => {
		expect(problems(withClaims({ email: "email", "scope.": "x", tenant: 3 }))).toEqual([
			"security.jwt.login.claims.email binds nothing: a claim binds tenant or scope.<parameter>",
			"security.jwt.login.claims.scope. binds nothing: a claim binds tenant or scope.<parameter>",
			"security.jwt.login.claims.tenant must be a claim name or JSON path string",
		])
		expect(problems(withClaims("org_id"))).toEqual(["security.jwt.login.claims must be a map of target → claim"])
	})
})

describe("login revoke", () => {
	it("is an operation id, or one with a body", () => {
		expect(problems({ jwt: { login: { from: "$.t", revoke: 3, steps } } })).toEqual([
			"security.jwt.login.revoke must be an operationId, or { operationId, body? }",
		])
		expect(problems({ jwt: { login: { from: "$.t", revoke: { body: {} }, steps } } })).toEqual([
			"security.jwt.login.revoke must be an operationId, or { operationId, body? }",
		])
		const revoke = { body: { token: "{credential}" }, operationId: "row.list" }
		expect(problems({ jwt: { login: { from: "$.t", revoke, steps } } })).toEqual([])
	})
})

describe("mint", () => {
	it("needs string with, operationId and from, and a revoke that names an operation", () => {
		const jwt = { login: { from: "$.t", steps } }
		expect(problems({ apiKey: { mint: { from: 2, operationId: "row.list", with: "jwt" } }, jwt })).toEqual([
			"security.apiKey.mint.from must be a JSON path string",
		])
		expect(problems({ apiKey: { mint: { from: "$.k", operationId: 7, with: 3 } }, jwt })).toEqual([
			"security.apiKey.mint.operationId must be a string",
			"security.apiKey.mint.with must be a string",
		])
		const revoked = { from: "$.k", operationId: "row.list", revoke: "row.revokee", with: "jwt" }
		expect(problems({ apiKey: { mint: revoked }, jwt })).toEqual([
			'security.apiKey.mint.revoke "row.revokee" names no operation',
		])
	})
})

describe("static", () => {
	const every = view(everyScheme)

	it("is a { username, password } pair for basic, and refuses a string there", () => {
		expect(problems({ basic: { static: { password: "p", username: "u" } } }, every)).toEqual([])
		expect(problems({ basic: { static: "u:p" } }, every)).toEqual([
			"security.basic.static must be { username, password } for a basic scheme",
		])
		expect(problems({ basic: { static: { username: "u" } } }, every)).toEqual([
			"security.basic.static must be { username, password } for a basic scheme",
		])
	})

	it("is a string for every other kind", () => {
		expect(problems({ header: { static: "k" } }, every)).toEqual([])
		expect(problems({ header: { static: { password: "p", username: "u" } } }, every)).toEqual([
			"security.header.static must be a string for an apiKey scheme",
		])
		expect(problems({ jwt: { static: { password: "p", username: "u" } } })).toEqual([
			"security.jwt.static must be a string for a bearer scheme",
		])
	})
})

describe("oauth2", () => {
	const scopes = { a: "" }
	const flows = { clientCredentials: { scopes, tokenUrl: "/t" }, password: { scopes, tokenUrl: "/t" } }
	const oauth = view({ ...keycloak, components: { securitySchemes: { o: { flows, type: "oauth2" } } } })

	it("needs a client id, string scopes, and a user for the password flow", () => {
		expect(problems({ o: { oauth2: { flow: "clientCredentials", scopes: "a" } } }, oauth)).toEqual([
			"security.o.oauth2.clientId must be a string",
			"security.o.oauth2.scopes must be a list of scope names",
		])
		expect(problems({ o: { oauth2: { clientId: "c", flow: "password" } } }, oauth)).toEqual([
			"security.o.oauth2.password must be a string for the password flow",
			"security.o.oauth2.username must be a string for the password flow",
		])
		const full = { clientId: "c", flow: "password", password: "p", scopes: ["a"], username: "u" }
		expect(problems({ o: { oauth2: full } }, oauth)).toEqual([])
	})
})

describe("format and hook", () => {
	const login = { from: "$.t", steps }

	it("needs {credential} in a format", () => {
		expect(problems({ jwt: { format: "Bearer token", login } })).toEqual([
			"security.jwt.format must contain {credential}",
		])
		expect(problems({ jwt: { format: "Token {credential}", login } })).toEqual([])
	})

	it("needs hook: true and a hooks.resolveCredential to call", () => {
		expect(problems({ jwt: { hook: true } })).toEqual(["security.jwt.hook needs hooks.resolveCredential in the config"])
		expect(problems({ jwt: { hook: "yes" } }, ANYROW, { hooks: { resolveCredential: () => "" } })).toEqual([
			"security.jwt.hook must be true",
		])
		expect(problems({ jwt: { hook: true } }, ANYROW, { hooks: { resolveCredential: () => "" } })).toEqual([])
	})
})

describe("options and the kinds they fit", () => {
	const login = { from: "$.t", steps }

	it("keep refresh for a login, expiresIn.from for what answers with a credential, holds for static and hook", () => {
		expect(problems({ jwt: { refresh: login, static: "t" } })).toEqual([
			"security.jwt.refresh is for a login recipe only",
		])
		expect(problems({ jwt: { expiresIn: { from: "$.e" }, static: "t" } })).toEqual([
			"security.jwt.expiresIn.from reads the answer that issued the credential; a static recipe has none",
		])
		expect(problems({ jwt: { holds: ["a"], login } })).toEqual(["security.jwt.holds is for a static or hook recipe"])
		expect(problems({ jwt: { expiresIn: 60, static: "t" } })).toEqual([])
		expect(problems({ jwt: { expiresIn: { from: "$.e" }, login, refresh: login } })).toEqual([])
	})

	it("catch the same mistake made through a principal's override", () => {
		const base = { jwt: { expiresIn: { from: "$.expires_in" }, login, refresh: login } }
		const override = (security: Record<string, unknown>) =>
			securityProblems({ principals: { alpha: { security, tenant: "t" } }, security: base }, ANYROW)
		expect(override({ jwt: { static: "t" } })).toEqual([])
		expect(override({ jwt: { expiresIn: { from: "$.x" }, static: "t" } })).toEqual([
			"principals.alpha.security.jwt.expiresIn.from reads the answer that issued the credential; a static recipe has none",
		])
	})
})

describe("kindProblems", () => {
	it("passes a recipe of exactly one kind, names one of none, and refuses more than one", () => {
		expect(kindProblems("security.jwt", { login: {} })).toEqual([])
		expect(kindProblems("security.jwt", { format: "x" })).toEqual([
			"security.jwt needs exactly one of login, mint, static, hook, oauth2",
		])
		expect(kindProblems("security.jwt", { login: {}, static: "s" })).toEqual([
			"security.jwt has login and static; keep exactly one",
		])
	})
})
