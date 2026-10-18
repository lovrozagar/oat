import { describe, expect, it, vi } from "vitest"
import { contextFor, exchange, modelOf, op } from "../../__fixtures__/harness.ts"
import { readSet } from "../../sets/read.ts"
import { baseDocument, routes } from "./__fixtures__/documents.ts"
import { currentRecords, listOpFor, observe } from "./observe.ts"

vi.mock("../../sets/read.ts", async (original) => {
	const actual = await original<typeof import("../../sets/read.ts")>()
	return { ...actual, readSet: vi.fn(actual.readSet) }
})

const model = modelOf(baseDocument())
const seeded = [{ id: "w1", name: "seeded" }]

describe("currentRecords", () => {
	it("reads the instance fresh and keeps the seeded records behind it", async () => {
		const respond = routes({ "GET /widgets/w1": () => ({ body: { id: "w1", name: "renamed" }, status: 200 }) })
		const { ctx, sent } = contextFor(model, "listWidgets", respond, {
			readOp: op(model, "getWidget"),
			records: seeded,
		})
		expect(await currentRecords(ctx, { id: "w1" })).toEqual([{ id: "w1", name: "renamed" }, ...seeded])
		expect(sent[0]).toMatchObject({ method: "GET", options: { operationId: "getWidget" }, path: "/widgets/w1" })
	})

	it("keeps the seeded records when there is no read, or the scope cannot name the instance", async () => {
		const { ctx, sent } = contextFor(model, "listWidgets", () => undefined, { records: seeded })
		expect(await currentRecords(ctx, { id: "w1" })).toBe(seeded)
		const unnamed = contextFor(model, "listWidgets", () => undefined, {
			readOp: op(model, "getWidget"),
			records: seeded,
		})
		expect(await currentRecords(unnamed.ctx, {})).toBe(seeded)
		expect([...sent, ...unnamed.sent]).toEqual([])
	})

	it.each([
		["a failed read", { status: 404 }],
		["an empty body", { body: null, status: 200 }],
		["a list body", { body: [{ id: "w1" }], status: 200 }],
		["a scalar body", { body: "w1", status: 200 }],
	])("keeps the seeded records after %s", async (_, answer) => {
		const { ctx } = contextFor(model, "listWidgets", () => answer, {
			readOp: op(model, "getWidget"),
			records: seeded,
		})
		expect(await currentRecords(ctx, { id: "w1" })).toBe(seeded)
	})
})

describe("listOpFor", () => {
	it("is the entity's list operation, and undefined for an entity without one or not in the model", () => {
		const { ctx } = contextFor(model, "listWidgets", () => undefined)
		expect(listOpFor(ctx, "card")?.operationId).toBe("listCards")
		expect(listOpFor(ctx, "job")).toBeUndefined()
		expect(listOpFor(ctx, "nothing")).toBeUndefined()
	})
})

describe("observe", () => {
	it("lists the whole collection under the scope and returns its ids", async () => {
		const respond = routes({ "GET /boards/b1/cards": () => ({ body: [{ id: "c1" }, { id: "c2" }], status: 200 }) })
		const { ctx, sent } = contextFor(model, "listWidgets", respond)
		const seen = await observe(ctx, op(model, "listCards"), { board_id: "b1" })
		expect(seen).toMatchObject({ ids: ["c1", "c2"], status: "ok" })
		expect(sent.map((s) => s.path)).toEqual(["/boards/b1/cards"])
	})

	it("reads the context's scope by default, and reads afresh each time", async () => {
		const respond = routes({ "GET /boards/b1/cards": () => ({ body: [], status: 200 }) })
		const { ctx, sent } = contextFor(model, "listWidgets", respond, { scope: { board_id: "b1" } })
		await observe(ctx, op(model, "listCards"))
		await observe(ctx, op(model, "listCards"))
		expect(sent).toHaveLength(2)
	})

	it("is unfillable when the scope lacks a path parameter, and sends nothing", async () => {
		const { ctx, sent } = contextFor(model, "listWidgets", () => undefined)
		expect(await observe(ctx, op(model, "listCards"), {})).toEqual({ status: "unfillable" })
		expect(sent).toEqual([])
	})

	it("is an error carrying the failed page when the list fails", async () => {
		const { ctx } = contextFor(model, "listWidgets", () => ({ status: 500 }))
		const seen = await observe(ctx, op(model, "listWidgets"))
		expect(seen.status).toBe("error")
		expect(seen.status === "error" && seen.exchange.status).toBe(500)
		expect(seen).not.toHaveProperty("reason")
	})

	it("is an error with the read's reason when it covered only part of the collection", async () => {
		/* Every page serves the same record: the walk cannot reach the end of the set. */
		const { ctx } = contextFor(model, "listWidgets", () => ({ body: [{ name: "e1" }], status: 200 }))
		const seen = await observe(ctx, op(model, "listEvents"))
		expect(seen).toMatchObject({ reason: "pages repeat the same records", status: "error" })
	})

	it("names the read's size as the reason when an incomplete read gives none", async () => {
		const { ctx } = contextFor(model, "listWidgets", () => undefined)
		const last = { envelope: {}, exchange: exchange("GET", "/widgets", { status: 200 }), items: [] }
		vi.mocked(readSet).mockResolvedValueOnce({ complete: false, items: [], last, pages: [last], status: "ok" })
		const seen = await observe(ctx, op(model, "listWidgets"))
		expect(seen).toMatchObject({ reason: "the collection is larger than a read covers", status: "error" })
	})
})
