import { describe, expect, it } from "vitest"
import type { PrincipalEntry, Recipe } from "../config/types/security.ts"
import type { Scenario } from "../config/types/steps.ts"
import { UsageError } from "../errors/usage-error.ts"
import { assertAllowedReferences, pruneToAllow } from "./allow.ts"
import type { OpenApiDocument } from "./types.ts"

const doc = {
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/notes": {
			get: { operationId: "note.list" },
			parameters: [],
			post: { operationId: "note.create" },
		},
		"/notes/{id}": { delete: {}, get: { operationId: "note.read" } },
		"/odd": "not a path item",
		"/tags": { get: { operationId: "tag.list" }, put: "not an operation" },
	},
} as unknown as OpenApiDocument

describe("pruneToAllow", () => {
	it("reaches an OAS 3.2 query operation like any other", () => {
		const searchable = { openapi: "3.2.0", paths: { "/search": { query: { operationId: "search" } } } }
		const { doc: pruned, removed } = pruneToAllow(searchable as OpenApiDocument, [])
		expect(removed).toEqual(["search"])
		expect(pruned.paths).toEqual({})
		expect(pruneToAllow(searchable as OpenApiDocument, ["search"]).removed).toEqual([])
	})

	it("removes every operation the allowlist leaves out, and path items left empty", () => {
		const { doc: pruned, removed } = pruneToAllow(doc, ["note.list", "DELETE /notes/{id}"])
		expect(removed).toEqual(["note.create", "note.read", "tag.list"])
		expect(pruned.paths).toEqual({
			"/notes": { get: { operationId: "note.list" }, parameters: [] },
			"/notes/{id}": { delete: {} },
			"/odd": "not a path item",
		})
		expect(doc.paths?.["/tags"]).toBeDefined()
	})

	it("reads METHOD /path in any case of the method, and returns the names it kept", () => {
		const { kept, removed } = pruneToAllow(doc, ["note.list", "delete /notes/{id}"])
		expect(removed).toEqual(["note.create", "note.read", "tag.list"])
		expect([...kept].sort()).toEqual(["DELETE /notes/{id}", "note.list"])
	})

	it("refuses an allowlist naming an operation the document does not have", () => {
		expect(() => pruneToAllow(doc, ["note.list", "nope", "GET /x"])).toThrow(
			new UsageError('allow names "nope", "GET /x", which the document does not have'),
		)
	})

	it("reads a document without paths as having no operations", () => {
		expect(pruneToAllow({ openapi: "3.1.0" }, [])).toEqual({ doc: { openapi: "3.1.0" }, kept: new Set(), removed: [] })
	})
})

const kept: ReadonlySet<string> = new Set(["login", "note.list"])
const step = (operationId: string, origin?: string) => ({ operationId, ...(origin === undefined ? {} : { origin }) })

describe("assertAllowedReferences", () => {
	it("accepts a config that calls only kept operations, or calls elsewhere", () => {
		const security: Record<string, Partial<Recipe>> = {
			apiKey: { mint: { from: "$.k", operationId: "note.list", revoke: "note.list", with: "jwt" } },
			basic: { static: { password: "p", username: "u" } },
			jwt: {
				login: { from: "$.t", steps: [step("login"), step("sso", "https://idp"), { method: "GET", path: "/x" }] },
				refresh: { from: "$.t", steps: [step("login")] },
			},
		}
		const principals: Record<string, PrincipalEntry> = {
			a: { security: { jwt: { login: { from: "$.t", steps: [step("login")] } } } },
			b: {},
		}
		const scenarios = [
			{ covers: ["note.list"], id: "s", steps: [step("note.list"), { wait: 1 }, step("x", "https://other")] },
			{ covers: ["gone"], id: "remote", origin: "https://other", steps: [step("gone")] },
		] as unknown as Scenario[]
		expect(() => assertAllowedReferences(kept, { principals, scenarios, security })).not.toThrow()
		expect(() => assertAllowedReferences(kept, {})).not.toThrow()
	})

	it("names every removed operation the config still calls, once each", () => {
		const security: Record<string, Partial<Recipe>> = {
			apiKey: { mint: { from: "$.k", operationId: "key.create", revoke: "key.revoke", with: "jwt" } },
			jwt: { login: { from: "$.t", steps: [step("signin")] }, refresh: { from: "$.t", steps: [step("renew")] } },
		}
		const principals: Record<string, PrincipalEntry> = {
			a: { security: { jwt: { login: { from: "$.t", steps: [step("signin"), step("sso")] } } } },
		}
		const scenarios = [{ covers: ["note.read"], id: "s", steps: [step("note.create")] }] as unknown as Scenario[]
		expect(() => assertAllowedReferences(kept, { principals, scenarios, security })).toThrow(
			new UsageError(
				'allow removes operations the config still calls: security.apiKey mint "key.create"; ' +
					'security.apiKey revoke "key.revoke"; security.jwt login step "signin"; security.jwt refresh step "renew"; ' +
					'principals.a.security.jwt login step "signin"; principals.a.security.jwt login step "sso"; ' +
					'scenario "s" step "note.create"; scenario "s" covers "note.read"',
			),
		)
	})
})
