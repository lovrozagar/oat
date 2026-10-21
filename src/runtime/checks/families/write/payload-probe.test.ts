import { describe, expect, it } from "vitest"
import { STRING_PAYLOADS } from "../../../payloads.ts"
import { contextFor, exchange, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import { type PayloadProbe, identityOf, laneRecords, removeRecord, runLanes, writeField } from "./payload-probe.ts"
import { widgetApi, widgetDoc, type WidgetDocOptions } from "./__fixtures__/widget-api.ts"

function probeOf(
	respond: Responder,
	options: WidgetDocOptions = {},
): { probe: PayloadProbe; sent: ReturnType<typeof contextFor>["sent"] } {
	const model = modelOf(widgetDoc(options))
	const { ctx, sent } = contextFor(model, "listWidgets", {
		respond,
		fields: {
			createOp: op(model, "createWidget"),
			deleteOp: model.byOperationId.get("deleteWidget"),
			readOp: op(model, "getWidget"),
			updateOp: model.byOperationId.get("updateWidget"),
		},
	})
	const field = { maxLength: undefined, minLength: undefined, name: "note" }
	const writeOp = ctx.updateOp ?? op(model, "createWidget")
	return {
		probe: {
			check: "payload.string-survives",
			ctx,
			currents: new Map(),
			field,
			id: "w1",
			readOp: op(model, "getWidget"),
			writeOp,
		},
		sent,
	}
}

/* The widget backend, refusing the first create with 409. */
function refusingOnce(): Responder {
	let refused = false
	return (method, path, options) => {
		if (method !== "POST" || refused) return widgetApi()(method, path, options)
		refused = true
		return { status: 409 }
	}
}

describe("payload probe, a client-chosen identity", () => {
	it("sends a create refused for its client-chosen identity again under a fresh one, keeping the value", async () => {
		const item = { properties: { id: { type: "string" }, note: { type: "string" } }, type: "object" }
		const { probe, sent } = probeOf(refusingOnce(), { item, update: null })
		probe.ctx.takenIdentities = new Set()
		expect((await writeField(probe, "value", "")).status).toBe(201)
		const bodies = sent.map((s) => s.options.body as { id: string; note: string })
		expect(bodies.map((body) => body.note)).toEqual(["value", "value"])
		expect(bodies[1]?.id).not.toBe(bodies[0]?.id)
		/* The identity under test is the value itself: never drawn again. */
		const asIdentity = probeOf(refusingOnce(), { item, update: null })
		asIdentity.probe.ctx.takenIdentities = new Set()
		/* A run with no nonce draws all the same. */
		delete (asIdentity.probe.ctx as { nonce?: string }).nonce
		const probed = { ...asIdentity.probe, field: { ...asIdentity.probe.field, name: "id" } }
		expect((await writeField(probed, "mangled", "")).status).toBe(409)
		expect(asIdentity.sent.map((s) => (s.options.body as { id: string }).id)).toEqual(["mangled"])
	})
})

describe("payload probe", () => {
	it("writes a PUT over an empty representation when it holds no record to carry", async () => {
		const { probe, sent } = probeOf(widgetApi(), { update: "put" })
		await writeField(probe, "value", "w9")
		expect(sent[0]?.method).toBe("PUT")
		expect(sent[0]?.path).toBe("/widgets/w9")
		expect(sent[0]?.options.body).toMatchObject({ note: "value" })
	})

	it("refuses to write with neither an update nor a create", async () => {
		const { probe } = probeOf(widgetApi())
		const bare = { ...probe, ctx: { ...probe.ctx, createOp: undefined, updateOp: undefined } }
		await expect(writeField(bare, "value", "w1")).rejects.toThrow("payload probe has no write operation")
	})

	it("creates from the value alone when the create documents no body", async () => {
		const { probe, sent } = probeOf(widgetApi(), { update: null })
		const bodiless = { ...probe, ctx: { ...probe.ctx, model: { ...probe.ctx.model, rawOperations: new Map() } } }
		await writeField(bodiless, "value", "")
		expect(sent[0]?.options.body).toEqual({ note: "value" })
	})

	it("removes a created record only through create, and only with a delete", async () => {
		const { probe, sent } = probeOf(widgetApi(), { update: null })
		await removeRecord(probe, "w2")
		await removeRecord({ ...probe, ctx: { ...probe.ctx, deleteOp: undefined } }, "w3")
		expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["DELETE /widgets/w2"])
		const { probe: patching, sent: patchSent } = probeOf(widgetApi())
		await removeRecord(patching, "w4")
		expect(patchSent).toEqual([])
	})

	it("takes no identity from an answer outside 2xx that names none", async () => {
		const { probe, sent } = probeOf(widgetApi(), { update: null })
		expect(await identityOf(probe, exchange("POST", "/widgets", { body: { id: null }, status: 102 }))).toBeUndefined()
		expect(await identityOf(probe, exchange("POST", "/widgets", { body: {}, status: 303 }))).toBeUndefined()
		expect(await identityOf(probe, exchange("POST", "/widgets", { body: { id: 5 }, status: 500 }))).toBe("5")
		expect(sent).toEqual([])
	})

	it("needs no extra records through create, and lanes with no record write to the first", async () => {
		const { probe, sent } = probeOf(widgetApi(), { update: null })
		expect(await laneRecords(probe, 10)).toEqual(["w1"])
		const results = await runLanes({ ...probe, id: "" }, STRING_PAYLOADS.slice(0, 2), [])
		expect(results.map((result) => result?.kind)).toEqual(["kept", "kept"])
		expect(sent.filter((s) => s.method === "POST")).toHaveLength(2)
	})
})
