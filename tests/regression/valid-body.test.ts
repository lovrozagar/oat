import { describe, expect, it } from "vitest"
import { validBody } from "../../src/runtime/checks/payloads/body.ts"
import { reserveClientIdentity } from "../../src/runtime/checks/payloads/identity.ts"
import { Client } from "../../src/client/client.ts"
import { FindingCollector } from "../../src/runtime/finding.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { checkContext } from "../support/check-context.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * Checks run side by side, and two of them may build a create body before either request is
 * sent. Bodies must still differ — above all a client-chosen identity, which would otherwise send
 * the second create into the first one's record.
 */

const NOTE = {
	properties: { id: { maximum: 999, minimum: 1, type: "integer" }, name: { minLength: 1, type: "string" } },
	required: ["id", "name"],
	type: "object",
}

function context() {
	const document = {
		info: { title: "valid-body", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/notes": {
				get: {
					operationId: "note.list",
					responses: {
						"200": { content: { "application/json": { schema: { items: NOTE, type: "array" } } }, description: "ok" },
					},
				},
			},
		},
	} as OpenApiDocument
	const model = buildModel(document)
	const listOp = model.byOperationId.get("note.list")
	if (listOp === undefined) throw new Error("no list operation")
	return checkContext({
		client: new Client({ baseUrl: "http://127.0.0.1:1", redactor: new Redactor() }),
		entityName: "note",
		findings: new FindingCollector(),
		listOp,
		model,
		takenIdentities: new Set<string>(),
	})
}

describe("validBody", () => {
	it("builds different identities for bodies made before any request is sent", () => {
		const ctx = context()
		const ids = new Set(Array.from({ length: 5 }, () => String(validBody(ctx, NOTE).id)))
		expect(ids.size).toBe(5)
	})

	it("reserves the identity it hands out, so no later body reuses it", () => {
		const ctx = context()
		const first = String(validBody(ctx, NOTE).id)
		expect(ctx.takenIdentities?.has(first)).toBe(true)
	})
})

describe("reserveClientIdentity", () => {
	it("moves a body off an identity a record already holds, and reserves the one it lands on", () => {
		const ctx = context()
		ctx.takenIdentities?.add("999")
		const body = reserveClientIdentity(ctx, { id: 999, name: "x" }, NOTE, "probe")
		expect(String(body.id)).not.toBe("999")
		expect(body.name).toBe("x")
		expect(ctx.takenIdentities?.has(String(body.id))).toBe(true)
	})

	it("leaves a free identity as it is", () => {
		const ctx = context()
		expect(reserveClientIdentity(ctx, { id: 7, name: "x" }, NOTE, "probe").id).toBe(7)
	})
})
