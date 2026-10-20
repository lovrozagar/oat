import { describe, expect, it } from "vitest"
import { configProblems } from "./validate.ts"

const valid = {
	baseUrl: "http://127.0.0.1:8787",
	principals: { alpha: { tenant: "t1" } },
	spec: "openapi.json",
}

/* The valid config reading the version from a path under `scheme`. */
const versionRead = (scheme: unknown) => ({ ...valid, targetVersion: { from: "$.v", path: "/version", scheme } })

describe("config validation", () => {
	it("accepts a well-formed config", () => {
		expect(configProblems(valid, { forRun: true })).toEqual([])
		expect(
			configProblems({
				...valid,
				keepFixtures: true,
				maxInFlight: 8,
				maxRps: 2.5,
				network: { retries: 0 },
				payloads: "full",
				principals: { alpha: { rank: 1 } },
			}),
		).toEqual([])
	})

	it("accepts the scheme a targetVersion path is read under, and only as a string", () => {
		expect(configProblems(versionRead("bearer"))).toEqual([])
		expect(configProblems(versionRead(1))).toEqual(["config.targetVersion.scheme must be a string"])
	})

	it("names unknown keys and wrong types by path", () => {
		expect(configProblems({ ...valid, concurrency: 4 })).toEqual(["config.concurrency is not a config key"])
		expect(configProblems({ ...valid, maxInFlight: "8" })).toEqual([
			"config.maxInFlight must be an integer of at least 1",
		])
		expect(configProblems({ ...valid, cohortSize: 0 })).toEqual(["config.cohortSize must be an integer of at least 1"])
		expect(configProblems({ ...valid, principals: { a: { rank: "high" } } })).toEqual([
			"config.principals.a.rank must be an integer",
		])
		expect(configProblems({ ...valid, payloads: "some" })).toEqual([
			'config.payloads must be one of "full", "per-write-path"',
		])
	})
})

describe("config validation by kind of key", () => {
	it("names the expected type of every kind of key", () => {
		const wrong = {
			allow: "all",
			baseUrl: 1,
			entities: [],
			fence: null,
			globalHeaders: { accept: 1 },
			hooks: { other: 1, resolveCredential: "token", verifyRemoved: "yes" },
			keepFixtures: "no",
			maxRps: 0,
			network: { requestTimeoutMs: -1, retries: undefined },
			principals: { a: { rank: Number.NaN } },
			seed: 1.5,
		}
		expect(configProblems({ ...valid, ...wrong })).toEqual([
			"config.baseUrl must be a string",
			"config.allow must be an array",
			"config.entities must be an object",
			"config.fence must be an object",
			"config.globalHeaders.accept must be a string",
			"config.hooks.verifyRemoved must be a function",
			"config.hooks.resolveCredential must be a function",
			"config.keepFixtures must be true or false",
			"config.maxRps must be a number above 0",
			"config.network.requestTimeoutMs must be an integer of at least 0",
			"config.seed must be an integer",
			"config.principals.a.rank must be an integer",
		])
		expect(configProblems({ ...valid, hooks: [] })).toEqual(["config.hooks must be an object"])
		expect(configProblems({ ...valid, hooks: { verifyRemoved: () => true } })).toEqual([])
	})

	it("refuses a config that is not an object", () => {
		expect(configProblems(null, { forRun: true })).toEqual(["config must be an object"])
		expect(configProblems({ ...valid, principals: "alpha" }, { forRun: true })).toEqual([
			"config.principals must be a map of id → identity data",
		])
	})

	it("requires what a run needs, and only for a run", () => {
		expect(configProblems({ spec: "x" }, { forRun: true })).toEqual([
			"config.baseUrl is required",
			"config.principals is required",
		])
		expect(configProblems({ spec: "x" })).toEqual([])
		expect(configProblems({ ...valid, principals: {} }, { forRun: true })).toEqual([
			"config.principals declares no principal",
		])
	})
})

describe("the 0.25.0 credentials config", () => {
	it("accepts recipes, mapped origin schemes, a credential hook and extra secret header names", () => {
		const config = {
			...valid,
			globalHeaders: { "x-ia-tester-key": "k", "X-Request-Id": "r" },
			hooks: { resolveCredential: () => Promise.resolve("t") },
			origins: [{ baseUrl: "http://cdn.test", id: "cdn", security: { bearer: "jwt" }, spec: "cdn.json" }],
			principals: { alpha: { email: "a@x.test", scope: { project_id: "p1" }, tenant: "t1" } },
			redact: { headers: ["x-ia-tester-key"] },
			security: {
				apiKey: { format: "ApiKey {credential}", mint: { from: "$.key", operationId: "key.create", with: "jwt" } },
				jwt: { expiresIn: 900, login: { from: "$.token", steps: [{ operationId: "auth.login" }] } },
			},
		}
		expect(configProblems(config, { forRun: true })).toEqual([])
	})

	it("checks each recipe's kind and options without a document", () => {
		expect(configProblems({ ...valid, security: "jwt" })).toEqual(["config.security must be a map of scheme → recipe"])
		expect(configProblems({ ...valid, security: { jwt: "token" } })).toEqual([
			"config.security.jwt must be a recipe object",
		])
		expect(configProblems({ ...valid, security: { jwt: {} } })).toEqual([
			"config.security.jwt needs exactly one of login, mint, static, hook, oauth2",
		])
		expect(configProblems({ ...valid, security: { jwt: { expiresIn: 0, static: "t" } } })).toEqual([
			"config.security.jwt.expiresIn must be seconds above 0 or { from: <json path> }",
		])
	})

	it("checks origins[].security and redact", () => {
		const origin = { baseUrl: "http://cdn.test", id: "cdn", spec: "cdn.json" }
		expect(configProblems({ ...valid, origins: [{ ...origin, security: { bearer: 1 } }] })).toEqual([
			"config.origins[0].security.bearer must be a string",
		])
		expect(configProblems({ ...valid, redact: { cookies: [], headers: "x-key" } })).toEqual([
			"config.redact.cookies is not a config key",
			"config.redact.headers must be an array",
		])
	})
})

describe("what 0.25.0 removed, with what replaces it", () => {
	it("names the replacement for principals as an array and for each removed principal field", () => {
		expect(configProblems({ ...valid, principals: [{ id: "alpha" }] }, { forRun: true })).toEqual([
			"config.principals is a map of id → identity data now: { alpha: { email: …, tenant: … } }",
		])
		const alpha = { auth: {}, headers: {}, roots: {}, rootsFromFlow: {} }
		expect(configProblems({ ...valid, principals: { alpha } })).toEqual([
			"config.principals.alpha.auth was removed in 0.25.0: put the flow in security.<scheme>: { login: { steps, from } }",
			"config.principals.alpha.headers was removed in 0.25.0: a fixed credential is security.<scheme>: { static: … }",
			"config.principals.alpha.roots was removed in 0.25.0: bind its parameters with principals.alpha.scope and its tenant with tenant",
			"config.principals.alpha.rootsFromFlow was removed in 0.25.0: bind token claims with security.<scheme>.login.claims",
		])
	})

	it("names the replacement for each removed top-level key, and never calls one unknown", () => {
		expect(configProblems({ ...valid, roots: { project_id: "p" }, rootsFromFlow: {}, "x-auth-flows": {} })).toEqual([
			"config.roots was removed in 0.25.0: bind parameters per principal with principals.<id>.scope",
			"config.rootsFromFlow was removed in 0.25.0: bind token claims with security.<scheme>.login.claims",
			"config.x-auth-flows was removed in 0.25.0: declare a security.<scheme> recipe for each scheme the document declares",
		])
	})

	it("refuses a credential header in globalHeaders, whatever its case", () => {
		const globalHeaders = { Authorization: "Bearer t", cookie: "sid=1", "X-Request-Id": "r" }
		expect(configProblems({ ...valid, globalHeaders })).toEqual([
			"config.globalHeaders.Authorization was removed in 0.25.0: a credential is sent by its scheme; declare security.<scheme>",
			"config.globalHeaders.cookie was removed in 0.25.0: a credential is sent by its scheme; declare security.<scheme>",
		])
	})

	it("names the hook that replaces resolvePrincipalAuth", () => {
		expect(configProblems({ ...valid, hooks: { resolvePrincipalAuth: () => null } })).toEqual([
			"config.hooks.resolvePrincipalAuth was removed in 0.25.0: declare security.<scheme>: { hook: true } and return the credential from hooks.resolveCredential",
		])
	})
})
