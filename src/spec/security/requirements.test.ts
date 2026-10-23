import { describe, expect, it } from "vitest"
import type { OpenApiDocument, OperationObject } from "../types.ts"
import { anyrow, cloudflare, everyScheme, immich, keycloak } from "./__fixtures__/documents.ts"
import { resolveSecurity } from "./requirements.ts"

const opOf = (doc: typeof anyrow, path: string, method = "get"): OperationObject =>
	((doc.paths ?? {})[path] as Record<string, OperationObject>)[method] as OperationObject

describe("resolveSecurity", () => {
	it("takes the root requirement when the operation states none", () => {
		expect(resolveSecurity(opOf(anyrow, "/v1/me"), anyrow)).toEqual({
			alternatives: [[{ scheme: "jwt", scopes: [] }]],
			malformedScopes: [],
			source: "root",
			undeclared: [],
		})
	})

	it("lets the operation's requirement replace the root's, scopes kept", () => {
		expect(resolveSecurity(opOf(anyrow, "/v1/rows"), anyrow).alternatives).toEqual([
			[{ scheme: "jwt", scopes: [] }],
			[{ scheme: "apiKey", scopes: ["rows:read"] }],
		])
	})

	it("reads `security: []` on the operation as anonymous, overriding the root", () => {
		expect(resolveSecurity(opOf(anyrow, "/v1/auth/login", "post"), anyrow)).toEqual({
			alternatives: [[]],
			malformedScopes: [],
			source: "operation",
			undeclared: [],
		})
	})

	it("reads an empty object as an anonymous alternative beside the others", () => {
		expect(resolveSecurity(opOf(everyScheme, "/a"), everyScheme).alternatives).toEqual([
			[{ scheme: "basic", scopes: [] }],
			[],
		])
	})

	it("keeps an AND of schemes together, as one alternative", () => {
		expect(resolveSecurity(opOf(cloudflare, "/zones"), cloudflare).alternatives).toEqual([
			[
				{ scheme: "api_email", scopes: [] },
				{ scheme: "api_key", scopes: [] },
			],
			[{ scheme: "api_token", scopes: [] }],
		])
		expect(resolveSecurity(opOf(immich, "/api/assets"), immich).alternatives).toHaveLength(3)
	})

	it("is anonymous with no requirement anywhere, saying so", () => {
		expect(resolveSecurity(opOf(keycloak, "/admin/realms"), keycloak)).toEqual({
			alternatives: [[]],
			malformedScopes: [],
			source: "none",
			undeclared: [],
		})
	})

	it("names a required scheme the document never declares", () => {
		expect(resolveSecurity(opOf(everyScheme, "/c"), everyScheme).undeclared).toEqual(["missing"])
	})
})

/* Square's api.json gives RevokeToken `{ "oauth2": null }`. */
const secured = (security: unknown, at: "operation" | "root"): OpenApiDocument =>
	({
		components: { securitySchemes: { oauth2: { type: "oauth2" }, key: { type: "apiKey" } } },
		info: { title: "t", version: "1" },
		openapi: "3.0.0",
		paths: { "/revoke": { post: { operationId: "RevokeToken", ...(at === "operation" ? { security } : {}) } } },
		...(at === "root" ? { security } : {}),
	}) as unknown as OpenApiDocument

describe("resolveSecurity and a scope list that is not an array", () => {
	it("reads null, a string, an object or a number as no scopes, and names the scheme", () => {
		for (const scopes of [null, "PAYMENTS_READ", { read: true }, 7]) {
			for (const at of ["operation", "root"] as const) {
				const doc = secured([{ oauth2: scopes, key: [] }, { oauth2: ["A"] }], at)
				expect(resolveSecurity(opOf(doc, "/revoke", "post"), doc)).toEqual({
					alternatives: [
						[
							{ scheme: "oauth2", scopes: [] },
							{ scheme: "key", scopes: [] },
						],
						[{ scheme: "oauth2", scopes: ["A"] }],
					],
					malformedScopes: ["oauth2"],
					source: at,
					undeclared: [],
				})
			}
		}
	})

	it("names each scheme once, in order", () => {
		const doc = secured([{ oauth2: null }, { oauth2: null, key: "x" }], "operation")
		expect(resolveSecurity(opOf(doc, "/revoke", "post"), doc).malformedScopes).toEqual(["key", "oauth2"])
	})
})
