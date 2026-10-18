import { describe, expect, it } from "vitest"
import { absentId } from "../../src/runtime/checks/payloads/identity.ts"
import { Client } from "../../src/client/client.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import { absentIdentifier } from "../../src/runtime/generate.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * A probe for a record that does not exist must name one in the identity's own shape: a backend
 * answers a malformed id with 400 before existence is considered, and comparing that with a real
 * 404 reads as a defect that is not there. Behind a path parameter documented as a bare string,
 * an integer identity got `Quarterly Report 9001`.
 */

describe("absentIdentifier", () => {
	it("is a single token for a string identity", () => {
		const made = absentIdentifier({ type: "string" }, "n1")
		expect(made.ok).toBe(true)
		expect(String(made.ok ? made.value : "")).toMatch(/^oat-absent-\S+$/)
	})

	it("does not apply when the token cannot meet the identity's pattern or length", () => {
		expect(absentIdentifier({ pattern: "^[0-9]{3}$", type: "string" }, "n1").ok).toBe(false)
		expect(absentIdentifier({ maxLength: 4, type: "string" }, "n1").ok).toBe(false)
		expect(absentIdentifier({ enum: ["a", "b"], type: "string" }, "n1").ok).toBe(false)
	})

	it("keeps integers and uuids", () => {
		expect(absentIdentifier({ type: "integer" }, "n1")).toMatchObject({ ok: true, value: expect.any(Number) })
		expect(absentIdentifier({ format: "uuid", type: "string" }, "n1")).toMatchObject({ ok: true })
	})
})

const json = (schema: unknown) => ({ content: { "application/json": { schema } }, description: "ok" })

function context(identity: Record<string, unknown>) {
	const item = { properties: { ID: identity, name: { type: "string" } }, type: "object" }
	const model = buildModel({
		info: { title: "absent", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/notes": {
				get: {
					operationId: "note.list",
					responses: { "200": json({ items: item, type: "array" }) },
					"x-entity": { action: "list", identity: "ID", name: "note" },
				},
			},
			"/v1/notes/{noteId}": {
				delete: {
					operationId: "note.delete",
					/* A bare string, as some frameworks document every route parameter. */
					parameters: [{ in: "path", name: "noteId", required: true, schema: { type: "string" } }],
					responses: { "204": { description: "gone" } },
					"x-entity": { action: "delete", identity: "ID", name: "note" },
				},
			},
		},
	} as unknown as OpenApiDocument)
	const listOp = model.byOperationId.get("note.list")
	const deleteOp = model.byOperationId.get("note.delete")
	if (listOp === undefined || deleteOp === undefined) throw new Error("operations missing")
	return checkContext({
		client: new Client({ baseUrl: "http://127.0.0.1:1", redactor: new Redactor() }),
		deleteOp,
		entityName: "note",
		findings: new FindingCollector(),
		identity: "ID",
		listOp,
		model,
	})
}

describe("absentId", () => {
	it("takes the identity's type over a path parameter documented as a bare string", () => {
		expect(absentId(context({ type: "integer" }))).toMatch(/^[0-9]+$/)
		expect(absentId(context({ format: "uuid", type: "string" }))).toMatch(/^[0-9a-f-]{36}$/)
		expect(absentId(context({ type: "string" }))).toMatch(/^oat-absent-\S+$/)
	})
})
