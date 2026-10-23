import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { referenceRequest } from "../../reference/http/wire.ts"
import { bearerGuarded, bearerSecurity } from "./security.ts"
import { answer } from "./serve.ts"

function request(method: string, path: string, headers: Record<string, string> = {}) {
	return referenceRequest(method, new URL(path, "http://suite.test"), { headers, read: async () => "" })
}

describe("bearerSecurity", () => {
	it("declares one http bearer scheme and requires it at the root", () => {
		expect(bearerSecurity()).toEqual({
			components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
			security: [{ bearer: [] }],
		})
	})

	it("is a fresh object each time, so no document shares another's", () => {
		expect(bearerSecurity()).not.toBe(bearerSecurity())
		expect(bearerSecurity().security).not.toBe(bearerSecurity().security)
	})

	it("gives every operation of a document the bearer, from its root", () => {
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: { "/things": { get: { operationId: "thing.list", responses: { "200": { description: "ok" } } } } },
			...bearerSecurity(),
		} as OpenApiDocument
		const security = buildModel(dereference(doc).doc).byOperationId.get("thing.list")?.security
		expect(security).toEqual({
			alternatives: [[{ scheme: "bearer", scopes: [] }]],
			malformedScopes: [],
			source: "root",
			undeclared: [],
		})
	})
})

describe("bearerGuarded", () => {
	const guarded = bearerGuarded(async () => answer(200, { ok: true }), "tok")

	it("answers a request that carries the token it issued", async () => {
		expect((await guarded(request("GET", "/v1/things", { authorization: "Bearer tok" }))).status).toBe(200)
	})

	it("refuses no credential, and a bearer it never issued, with a 401", async () => {
		expect((await guarded(request("GET", "/v1/things"))).status).toBe(401)
		expect((await guarded(request("POST", "/v1/things", { authorization: "Bearer other" }))).status).toBe(401)
	})

	it("serves its document to anyone, since the document is public", async () => {
		expect((await guarded(request("GET", "/v1/openapi/spec"))).status).toBe(200)
		expect((await guarded(request("POST", "/v1/openapi/spec"))).status).toBe(401)
	})
})
