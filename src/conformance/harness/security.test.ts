import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { bearerSecurity } from "./security.ts"

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
		expect(security).toEqual({ alternatives: [[{ scheme: "bearer", scopes: [] }]], source: "root", undeclared: [] })
	})
})
