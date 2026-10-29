import { describe, expect, it } from "vitest"
import type { Responder } from "../../__fixtures__/harness.ts"
import { exchange } from "../../__fixtures__/harness.ts"
import { notesContext, notesModel, notesServer } from "../write/__fixtures__/notes.ts"
import { primedWrite, writeKinds } from "./freshness-write.ts"

function notes(more: { updateMethod?: "patch" | "put"; override?: Responder } = {}) {
	const server = notesServer()
	const model = notesModel(more.updateMethod === undefined ? {} : { updateMethod: more.updateMethod })
	const respond: Responder = (method, path, options) =>
		more.override?.(method, path, options) ?? server.respond(method, path, options)
	const { ctx, sent } = notesContext(model, respond, { records: [] })
	return { ctx, readOp: ctx.readOp as NonNullable<typeof ctx.readOp>, sent }
}

describe("writeKinds", () => {
	it("is the update, then the delete, of those the entity has", () => {
		const { ctx } = notes()
		expect(writeKinds(ctx)).toEqual(["update", "delete"])
		expect(writeKinds({ ...ctx, updateOp: undefined })).toEqual(["delete"])
		expect(writeKinds({ ...ctx, deleteOp: undefined, updateOp: undefined })).toEqual([])
	})
})

describe("primedWrite", () => {
	it("reads the scratch record through the cache, then patches one field, and knows the read that shows it", async () => {
		const { ctx, readOp, sent } = notes()
		const written = await primedWrite(ctx, { check: "c", kind: "update", readOp })
		if ("outcome" in written) throw new Error("expected a write")
		expect(sent.map((s) => `${s.method} ${s.path}${s.options.cache === "use" ? " (cache)" : ""}`)).toEqual([
			"POST /notes",
			"GET /notes/n1 (cache)",
			"PATCH /notes/n1",
		])
		const [field, value] = Object.entries(sent[2]?.options.body as object)[0] as [string, unknown]
		expect(Object.keys(sent[2]?.options.body as object)).toHaveLength(1)
		expect(written.shows(exchange("GET", "/notes/n1", { body: { [field]: value }, status: 200 }))).toBe(true)
		expect(written.shows(exchange("GET", "/notes/n1", { body: { [field]: "old" }, status: 200 }))).toBe(false)
	})

	it("sends a PUT a whole valid body", async () => {
		const { ctx, readOp, sent } = notes({ updateMethod: "put" })
		await primedWrite(ctx, { check: "c", kind: "update", readOp })
		expect(sent[2]?.method).toBe("PUT")
		expect(Object.keys(sent[2]?.options.body as object).length).toBeGreaterThan(1)
	})

	it("knows a delete shows as 404 or 410", async () => {
		const { ctx, readOp } = notes()
		const written = await primedWrite(ctx, { check: "c", kind: "delete", readOp })
		if ("outcome" in written) throw new Error("expected a write")
		expect(written.shows(exchange("GET", "/notes/n1", { status: 404 }))).toBe(true)
		expect(written.shows(exchange("GET", "/notes/n1", { status: 410 }))).toBe(true)
		expect(written.shows(exchange("GET", "/notes/n1", { body: {}, status: 200 }))).toBe(false)
	})

	it("cannot decide when the record cannot be read before the write", async () => {
		const { ctx, readOp } = notes({ override: (method) => (method === "GET" ? { status: 500 } : undefined) })
		expect(await primedWrite(ctx, { check: "c", kind: "update", readOp })).toEqual({
			outcome: { kind: "unresolved", reason: "reading the record returned 500" },
		})
	})
})
