import { describe, expect, it } from "vitest"
import { UsageError } from "../errors/usage-error.ts"
import { doc } from "./__fixtures__/documents.ts"
import { buildModel } from "./graph/build.ts"
import { applyOverlay } from "./overlay.ts"
import { dereference } from "./load/dereference.ts"
import { anyrow, keycloak } from "./security/__fixtures__/documents.ts"
import type { OpenApiDocument } from "./types.ts"

const source = () =>
	doc(
		{
			"/notes": {
				get: { operationId: "notes.list", tags: ["a"], "x-cost": "high", "x-query": { maxLimit: 10, sortable: ["a"] } },
				post: { summary: "unnamed" },
				parameters: [],
			},
			"/skip": "not a path item",
			"/other": { put: { operationId: "other.put" } },
		},
		{ components: { schemas: { Note: { properties: { id: { type: "string" } }, required: ["id"] } } } },
	)

/* One operation of a patched document. */
const opAt = (out: OpenApiDocument, path: string, method: string): Record<string, unknown> =>
	(out.paths as Record<string, Record<string, Record<string, unknown>>>)[path]?.[method] ?? {}

describe("applyOverlay", () => {
	it("patches an OAS 3.2 query operation by its operationId", () => {
		const out = applyOverlay(doc({ "/search": { query: { operationId: "search" } } }), {
			operations: { search: { "x-cost": "low" } },
		})
		expect(opAt(out, "/search", "query")).toEqual({ operationId: "search", "x-cost": "low" })
	})

	it("merges objects, replaces arrays and scalars, and deletes on null, on a copy", () => {
		const original = source()
		const out = applyOverlay(original, {
			operations: {
				"notes.list": { tags: ["b"], "x-cost": null, "x-query": { maxLimit: 50, sortable: ["b"] } },
			},
			schemas: { Note: { properties: { name: { type: "string" } }, required: null } },
		})
		expect(opAt(out, "/notes", "get")).toEqual({
			operationId: "notes.list",
			tags: ["b"],
			"x-query": { maxLimit: 50, sortable: ["b"] },
		})
		expect(out.components?.schemas?.["Note"]).toEqual({
			properties: { id: { type: "string" }, name: { type: "string" } },
		})
		expect(original).toEqual(source())
	})

	it("replaces an operation outright when the patch or the operation is not an object", () => {
		const out = applyOverlay(source(), { operations: { "other.put": { operationId: "other.put" } } })
		expect(opAt(out, "/other", "put")).toEqual({ operationId: "other.put" })
	})

	it("lets an operation keep or take a fresh id, but not one another operation has", () => {
		expect(() => applyOverlay(source(), { operations: { "notes.list": { operationId: "notes.list" } } })).not.toThrow()
		const renamed = applyOverlay(source(), { operations: { "notes.list": { operationId: "notes.all" } } })
		expect(opAt(renamed, "/notes", "get")["operationId"]).toBe("notes.all")
		expect(() => applyOverlay(source(), { operations: { "notes.list": { operationId: "other.put" } } })).toThrow(
			new UsageError('overlay.operations["notes.list"] renames it to "other.put", which another operation has'),
		)
	})

	it("refuses a patch that names nothing", () => {
		expect(() => applyOverlay(source(), { operations: { "POST /notes": {} } })).toThrow(
			'overlay.operations["POST /notes"] names no operation in the document',
		)
		expect(() => applyOverlay(source(), { schemas: { Missing: {} } })).toThrow(
			'overlay.schemas["Missing"] names no schema under components.schemas',
		)
		expect(() => applyOverlay(doc({}), { schemas: { Note: {} } })).toThrow("names no schema")
	})

	it("applies an empty overlay to a document without paths", () => {
		expect(applyOverlay({ openapi: "3.1.0" }, {})).toEqual({ openapi: "3.1.0" })
	})
})

describe("applyOverlay on security", () => {
	it("declares a security scheme and a root requirement on a document that has none", () => {
		const out = applyOverlay(keycloak, {
			security: [{ bearer: [] }],
			securitySchemes: { bearer: { scheme: "bearer", type: "http" } },
		})
		const model = buildModel(dereference(out).doc)
		expect(model.schemes.get("bearer")?.kind).toBe("bearer")
		expect(model.operations.map((op) => op.security.alternatives)).toEqual([[[{ scheme: "bearer", scopes: [] }]]])
		expect(keycloak.components).toBeUndefined()
	})

	it("null deletes a declared scheme, an object merges into one, and security replaces the root", () => {
		const out = applyOverlay(anyrow, {
			security: [{ apiKey: [] }],
			securitySchemes: { apiKey: { description: null }, jwt: null },
		})
		expect(out.components?.securitySchemes).toEqual({
			apiKey: { in: "header", name: "Authorization", type: "apiKey" },
		})
		expect(out.security).toEqual([{ apiKey: [] }])
		expect(anyrow.security).toEqual([{ jwt: [] }])
	})
})
