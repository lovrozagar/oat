import { describe, expect, it } from "vitest"
import type { Recipe } from "../config/types/security.ts"
import { type Requirement, resolveSecurity } from "../spec/security/requirements.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { satisfy } from "./satisfy.ts"

const login: Partial<Recipe> = { from: "$.token", steps: [{ operationId: "auth.login" }] } as never
const recipesOf =
	(recipes: Record<string, Partial<Recipe>>) =>
	(scheme: string): Partial<Recipe> | undefined =>
		recipes[scheme]
const need = (scheme: string, ...scopes: string[]): Requirement => ({ scheme, scopes })
const offered = (...alternatives: Requirement[][]) => ({ alternatives })

describe("satisfy: alternatives", () => {
	it("takes the first satisfiable alternative in document order", () => {
		const both = recipesOf({ apiKey: { holds: ["rows:read"], static: "k" }, jwt: { login: login } as never })
		const security = offered([need("jwt")], [need("apiKey", "rows:read")])
		expect(satisfy(security, both)).toEqual({ alternative: [need("jwt")] })
		const keyOnly = recipesOf({ apiKey: { holds: ["rows:read"], static: "k" } })
		expect(satisfy(security, keyOnly)).toEqual({ alternative: [need("apiKey", "rows:read")] })
	})

	it("needs every scheme of an alternative", () => {
		const security = offered([need("email"), need("key")], [need("token")])
		const pair = recipesOf({ email: { static: "e" }, key: { static: "k" } })
		expect(satisfy(security, pair)).toEqual({ alternative: [need("email"), need("key")] })
		const half = recipesOf({ email: { static: "e" }, token: { static: "t" } })
		expect(satisfy(security, half)).toEqual({ alternative: [need("token")] })
	})

	it("reads the anonymous alternative, [] or {}, as satisfied with nothing to send", () => {
		expect(satisfy(offered([]), recipesOf({}))).toEqual({ alternative: [] })
		expect(satisfy(offered([need("jwt")], []), recipesOf({}))).toEqual({ alternative: [] })
	})

	it("reads a document's security: [] and [{}] as anonymous, and {} beside a scheme as an anonymous fallback", () => {
		const doc = { info: { title: "t", version: "1" }, openapi: "3.1.0", paths: {} } as OpenApiDocument
		const of = (security: Array<Record<string, string[]>>) => resolveSecurity({ responses: {}, security }, doc)
		expect(satisfy(of([]), recipesOf({}))).toEqual({ alternative: [] })
		expect(satisfy(of([{}]), recipesOf({}))).toEqual({ alternative: [] })
		expect(satisfy(of([{ jwt: [] }, {}]), recipesOf({}))).toEqual({ alternative: [] })
		expect(satisfy(of([{ jwt: [] }, {}]), recipesOf({ jwt: { static: "t" } }))).toEqual({ alternative: [need("jwt")] })
	})

	it("names the scheme it has no credential for, once per alternative that failed", () => {
		expect(satisfy(offered([need("jwt")]), recipesOf({}))).toEqual({ unsatisfied: "no credential for jwt" })
		const two = offered([need("jwt")], [need("email"), need("key")], [need("jwt")])
		expect(satisfy(two, recipesOf({ email: { static: "e" } }))).toEqual({
			unsatisfied: "no credential for jwt; no credential for key",
		})
	})

	it("counts a recipe that names no kind as no credential", () => {
		expect(satisfy(offered([need("jwt")]), recipesOf({ jwt: { format: "JWT {credential}" } }))).toEqual({
			unsatisfied: "no credential for jwt",
		})
	})
})

describe("satisfy: scopes", () => {
	const scoped = offered([need("key", "rows:read", "rows:write")])

	it("takes a static or hook credential only when it holds every scope", () => {
		const holds = recipesOf({ key: { holds: ["rows:read", "rows:write", "admin"], static: "k" } })
		expect(satisfy(scoped, holds)).toEqual({ alternative: [need("key", "rows:read", "rows:write")] })
		const partial = recipesOf({ key: { hook: true, holds: ["rows:read"] } })
		expect(satisfy(scoped, partial)).toEqual({ unsatisfied: "no credential for key holding rows:write" })
		const none = recipesOf({ key: { static: "k" } })
		expect(satisfy(scoped, none)).toEqual({ unsatisfied: "no credential for key holding rows:read, rows:write" })
	})

	it("trusts a login to hold whatever the document scopes", () => {
		expect(satisfy(scoped, recipesOf({ key: { login: login } as never }))).toHaveProperty("alternative")
	})

	it("lets oauth2, and a mint whose body asks for {scopes}, issue them", () => {
		const oauth2 = recipesOf({ key: { oauth2: { clientId: "c", flow: "clientCredentials" } } })
		expect(satisfy(scoped, oauth2)).toHaveProperty("alternative")
		const mint = { from: "$.key", operationId: "key.create", with: "jwt" }
		const asks = recipesOf({ key: { mint: { ...mint, body: { name: "oat", scopes: "{scopes}" } } } })
		expect(satisfy(scoped, asks)).toHaveProperty("alternative")
		const fixed = recipesOf({ key: { mint: { ...mint, body: { scopes: ["rows:read"] } } } })
		expect(satisfy(scoped, fixed)).toEqual({ unsatisfied: "no credential for key holding rows:read, rows:write" })
		const holding = recipesOf({ key: { holds: ["rows:read", "rows:write"], mint } })
		expect(satisfy(scoped, holding)).toHaveProperty("alternative")
	})

	it("asks nothing of a credential when the requirement names no scope", () => {
		expect(satisfy(offered([need("key")]), recipesOf({ key: { static: "k" } }))).toHaveProperty("alternative")
	})
})
