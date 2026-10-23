import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { operationContextFor } from "./__fixtures__/operation-context.ts"
import { NOTE_TARGET, securedDoc } from "./__fixtures__/secured-api.ts"
import { readOf, recordAt, writableBody } from "./writable.ts"

/* A write probe's harmless body: the record as it is, cut to what the operation's request body accepts. */

const model = modelOf(securedDoc())
const update = operationContextFor(model, "notes.update").ctx

describe("writableBody", () => {
	it("keeps the properties the request schema declares, dropping readOnly ones and any it does not name", () => {
		expect(writableBody(update, { created_at: "t", id: "n1", other: 1, title: "first" })).toEqual({ title: "first" })
	})

	it("leaves out a property only the highest rank may set: an ordinary writer never sends it", () => {
		expect(writableBody(update, { id: "n1", title: "first", verified: false })).toEqual({ title: "first" })
	})

	it("sends the record as it is when the request schema names no properties, or there is no body", () => {
		const free = securedDoc()
		const paths = (free as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths
		const patch = paths["/projects/{project_id}/notes/{note_id}"]?.["patch"] as Record<string, unknown>
		patch["requestBody"] = { content: { "application/json": { schema: { type: "object" } } }, required: true }
		const record = { id: "n1", title: "first" }
		expect(writableBody(operationContextFor(modelOf(free), "notes.update").ctx, record)).toEqual(record)
		expect(writableBody(operationContextFor(model, "notes.delete").ctx, record)).toEqual(record)
	})
})

describe("readOf and recordAt", () => {
	it("finds the GET on the write's path, and reads the record out of its answer", () => {
		expect(readOf(update)?.operationId).toBe("notes.get")
		expect(readOf(operationContextFor(model, "notes.list").ctx)?.operationId).toBe("notes.list")
		expect(readOf(operationContextFor(model, "auth.revoke").ctx)).toBeUndefined()
		expect(recordAt(update, NOTE_TARGET.current)).toEqual(NOTE_TARGET.current)
		expect(recordAt(update, "text")).toBeUndefined()
		expect(recordAt(operationContextFor(model, "auth.revoke").ctx, { a: 1 })).toEqual({ a: 1 })
	})
})
