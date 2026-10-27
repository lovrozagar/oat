import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import {
	freshView,
	placeholders,
	principalMapProblems,
	principalProblems,
	removedProblems,
	REMOVED_KEYS,
} from "./principals.ts"

describe("principal placeholders", () => {
	it("finds every {principal.<key>} however deeply a recipe nests it", () => {
		const recipe = { login: { steps: [{ body: { a: "{principal.email}", b: ["{principal.password}", 3] } }] } }
		expect([...placeholders(recipe)].toSorted()).toEqual(["email", "password"])
		expect(placeholders(null).size).toBe(0)
	})
})

describe("principalProblems", () => {
	const schemes = new Set(["jwt"])

	it("asks nothing of a config with no principals: only a run needs one, and configProblems says so", () => {
		expect(principalProblems({}, schemes)).toEqual([])
	})

	it("wants a map", () => {
		expect(principalProblems({ principals: "alpha" }, schemes)).toEqual([
			"principals must be a map of id → identity data",
		])
	})

	it("binds parameters only through scope, a map of parameter to string", () => {
		expect(principalProblems({ principals: { alpha: { scope: { project_id: "p1" } } } }, schemes)).toEqual([])
		expect(principalProblems({ principals: { alpha: { scope: "p1" } } }, schemes)).toEqual([
			"principals.alpha.scope must be a map of parameter → value",
		])
		expect(principalProblems({ principals: { alpha: { scope: { project_id: 7, org: "o" } } } }, schemes)).toEqual([
			"principals.alpha.scope.project_id must be a string",
		])
	})

	it("names scope as what replaces roots", () => {
		expect(principalProblems({ principals: { alpha: { roots: { project_id: "p1" } } } }, schemes)).toEqual([
			"principals.alpha.roots was removed in 0.25.0: bind its parameters with principals.alpha.scope and its tenant with tenant",
		])
	})

	it("names claims as what replaces a principal's rootsFromFlow", () => {
		expect(principalProblems({ principals: { alpha: { rootsFromFlow: { project_id: "pid" } } } }, schemes)).toEqual([
			"principals.alpha.rootsFromFlow was removed in 0.25.0: bind token claims with security.<scheme>.login.claims",
		])
	})

	it("reads recipes from security only when there is one", () => {
		expect(principalProblems({ principals: { alpha: { tenant: "t" } }, security: [] }, schemes)).toEqual([])
	})

	it("wants every principal a scenario or its step sends as to be one the config declares", () => {
		const scenarios = [
			{ id: "peer", principal: "beta", steps: [{ operationId: "a" }, { operationId: "b", principal: "gamma" }] },
			{ id: "own", steps: [{ operationId: "a", principal: "alpha" }, "raw"] },
			{ id: "bare", principal: "alpha" },
			"raw",
		]
		expect(principalProblems({ principals: { alpha: { tenant: "t" } }, scenarios }, schemes)).toEqual([
			'scenarios.peer.principal names "beta", which principals does not declare',
			'scenarios.peer.steps[1].principal names "gamma", which principals does not declare',
		])
	})
})

describe("principalMapProblems", () => {
	it("checks the map without a document, so it cannot know which schemes an override names", () => {
		const principals = { alpha: { rank: "high", security: { nope: { static: "x" } } } }
		expect(principalMapProblems({ principals })).toEqual(["principals.alpha.rank must be an integer"])
		expect(principalProblems({ principals }, new Set(["jwt"]))).toEqual([
			"principals.alpha.rank must be an integer",
			"principals.alpha.security.nope names no scheme in the document. The document declares: jwt",
		])
	})
})

describe("removedProblems", () => {
	it("says nothing when no removed field is present", () => {
		expect(removedProblems({ principals: {} })).toEqual([])
	})

	it("names what replaces top-level roots", () => {
		expect(removedProblems({ roots: { project_id: "p1" } })).toEqual([
			"roots was removed in 0.25.0: bind parameters per principal with principals.<id>.scope",
		])
	})
	it("names what replaces the x-auth-flows tag, and lists every removed top-level key", () => {
		expect(removedProblems({ "x-auth-flows": {} })).toEqual([
			"x-auth-flows was removed in 0.25.0: declare a security.<scheme> recipe for each scheme the document declares",
		])
		expect(REMOVED_KEYS.toSorted()).toEqual(["roots", "rootsFromFlow", "x-auth-flows"])
	})
})

describe("principalMapProblems, entry by entry", () => {
	it("refuses an empty map, an array, and an entry that is not an object", () => {
		expect(principalMapProblems({ principals: {} })).toEqual(["principals declares no principal"])
		expect(principalMapProblems({ principals: [{ id: "alpha" }] })).toEqual([
			"principals is a map of id → identity data now: { alpha: { email: …, tenant: … } }",
		])
		expect(principalProblems({ principals: { alpha: 1 } }, new Set())).toEqual([
			"principals.alpha must be an object of identity data",
		])
	})

	it("names the replacement for a principal's auth and headers, and checks each graded field", () => {
		const alpha = {
			auth: {},
			created: 1,
			fresh: "yes",
			headers: {},
			inviteAs: 1,
			rank: 1.5,
			readOnly: false,
			tenant: 2,
		}
		expect(principalMapProblems({ principals: { alpha } })).toEqual([
			"principals.alpha.auth was removed in 0.25.0: put the flow in security.<scheme>: { login: { steps, from } }",
			"principals.alpha.headers was removed in 0.25.0: a fixed credential is security.<scheme>: { static: … }",
			"principals.alpha.created must be true or false",
			"principals.alpha.fresh must be true or false",
			"principals.alpha.inviteAs must be a string",
			"principals.alpha.rank must be an integer",
			"principals.alpha.readOnly must be true, or left out",
			"principals.alpha.tenant must be a string",
		])
		const fine = { created: false, fresh: true, inviteAs: "a@x.test", rank: 2, readOnly: true, tenant: "t1" }
		expect(principalMapProblems({ principals: { alpha: fine } })).toEqual([])
	})

	it("wants every {principal.<key>} the recipe it will use names, an override's included", () => {
		const security = { jwt: { login: { from: "$.t", steps: [{ body: { email: "{principal.email}" } }] } } }
		const beta = { security: { apiKey: { static: "{principal.key}" }, jwt: { static: "t" } } }
		expect(principalMapProblems({ principals: { alpha: {}, beta }, security })).toEqual([
			'principals.alpha has no "email", which security.jwt uses as {principal.email}',
			'principals.beta has no "key", which security.apiKey uses as {principal.key}',
		])
	})

	it("leaves a fresh principal's placeholders to its signup, whose body fills its identity", () => {
		const security = { jwt: { login: { from: "$.t", steps: [{ body: { email: "{principal.email}" } }] } } }
		expect(principalMapProblems({ principals: { alpha: { fresh: true } }, security })).toEqual([])
	})
})

describe("principal overrides, against a document with no schemes", () => {
	it("say the document declares none", () => {
		expect(principalProblems({ principals: { alpha: { security: { jwt: { static: "t" } } } } }, new Set())).toEqual([
			"principals.alpha.security.jwt names no scheme in the document. The document declares no security scheme",
		])
	})
})

describe("fresh principals, against the document's signup", () => {
	const security = {
		jwt: { login: { from: "$.t", steps: [{ body: { email: "{principal.email}", code: "{principal.code}" } }] } },
	}
	const signup = { operationId: "auth.signup", properties: ["email", "password"] }

	it("take a placeholder from the signup body's properties or the config entry", () => {
		const principals = { fresh: { code: "1234", fresh: true } }
		expect(principalProblems({ principals, security }, new Set(["jwt"]), signup)).toEqual([])
	})

	it("name the key and the operation when neither holds it", () => {
		const principals = { fresh: { fresh: true } }
		expect(principalProblems({ principals, security }, new Set(["jwt"]), signup)).toEqual([
			'principals.fresh has no "code", and auth.signup\'s request body names no such property, which security.jwt uses as {principal.code}',
		])
	})

	it("cannot be signed up by a document that marks no x-fresh-principal operation", () => {
		const principals = { alpha: { email: "a@x.test" }, fresh: { email: "f@x.test", fresh: true } }
		expect(principalProblems({ principals, security: {} }, new Set())).toEqual([
			"principals.fresh is fresh, but the document marks no x-fresh-principal operation to sign it up",
		])
	})
})

/** A document whose only operation is the signup it marks x-fresh-principal, with `requestBody`. */
const docWith = (requestBody?: unknown): OpenApiDocument =>
	({
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/signup": {
				post: {
					operationId: "auth.signup",
					requestBody,
					responses: { "201": { description: "made" } },
					"x-fresh-principal": true,
				},
			},
		},
	}) as unknown as OpenApiDocument

describe("freshView", () => {
	it("names the signup operation and the properties its body declares, or none it declares nothing for", () => {
		const body = { content: { "application/json": { schema: { properties: { email: {} }, type: "object" } } } }
		expect(freshView(buildModel(docWith(body)))).toEqual({ operationId: "auth.signup", properties: ["email"] })
		const loose = { content: { "application/json": { schema: { type: "object" } } } }
		expect(freshView(buildModel(docWith(loose)))).toEqual({ operationId: "auth.signup", properties: [] })
		const none = { ...docWith(), paths: {} } as OpenApiDocument
		expect(freshView(buildModel(none))).toBeUndefined()
	})
})
