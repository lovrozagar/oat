import { describe, expect, it } from "vitest"
import { modelOf } from "../checks/__fixtures__/harness.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { ASCII_PAYLOAD_PROBE } from "../checks/families/write/payload-cases.ts"
import { contextOf, notesApi, notesDoc, optionsFor, transport } from "./__fixtures__/api.ts"
import { entityLanes, runLanes } from "./lanes.ts"

/*
 * Entities that can observe each other's writes share a lane and run in series; lanes run side by
 * side. However the lanes finish, the result reads in plan order.
 */

const item = { properties: { id: { type: "string" } }, type: "object" }
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ok = (schema: unknown) => ({ "200": { description: "ok", ...json(schema) } })
const list = (operationId: string, extra: Record<string, unknown> = {}) => ({
	get: { operationId, responses: ok({ items: item, type: "array" }), ...extra },
})
const param = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })

/** A document of `paths`, each a collection. */
const docOf = (paths: Record<string, unknown>): OpenApiDocument =>
	({ info: { title: "t", version: "1" }, openapi: "3.1.0", paths }) as unknown as OpenApiDocument

const names = (lanes: Array<Array<{ name: string }>>) => lanes.map((lane) => lane.map((entity) => entity.name))

describe("entityLanes", () => {
	it("keeps entities that share nothing in lanes of their own", () => {
		const model = modelOf(docOf({ "/a": list("a.list"), "/b": list("b.list") }))
		expect(names(entityLanes(model, [...model.entities.values()]))).toEqual([["a"], ["b"]])
	})

	it("puts a collection nested under another in its lane", () => {
		const model = modelOf(
			docOf({
				"/boards/": list("board.list"),
				"/boards/{board_id}/cards": { get: { ...list("card.list").get, parameters: [param("board_id")] } },
				"/tags": list("tag.list"),
			}),
		)
		expect(names(entityLanes(model, [...model.entities.values()]))).toEqual([["board", "card"], ["tag"]])
	})

	it("joins entities an operation invalidates, affects, waits on or polls", () => {
		const model = modelOf(
			docOf({
				"/a": list("a.list", { "x-invalidate": ["GET /b"] }),
				"/b": list("b.list"),
				"/c": list("c.list", { "x-effects": [{ entity: "d", op: "create" }] }),
				"/d": list("d.list"),
				"/e": list("e.list", { "x-wait": { operationId: "f.list", until: "id.eq.x" } }),
				"/f": list("f.list"),
				"/g": list("g.list", {
					"x-async": { idFrom: "$.id", poll: "GET /h", successWhen: "id.eq.x", until: "id.eq.x" },
				}),
				"/h": list("h.list"),
				"/i": list("i.list", {
					"x-async": { idFrom: "$.id", poll: "j.list", successWhen: "id.eq.x", until: "id.eq.x" },
				}),
				"/j": list("j.list"),
				"/k": list("k.list", { "x-invalidate": ["GET /nowhere"] }),
			}),
		)
		expect(names(entityLanes(model, [...model.entities.values()]))).toEqual([
			["a", "b"],
			["c", "d"],
			["e", "f"],
			["g", "h"],
			["i", "j"],
			["k"],
		])
	})
})

describe("entityLanes without a list", () => {
	it("places an entity by its create when it has no list, and alone when it has neither", () => {
		const model = modelOf(
			docOf({
				"/a": list("a.list"),
				"/a/{a_id}/b": {
					post: { operationId: "b.create", parameters: [param("a_id")], requestBody: json(item), responses: ok(item) },
				},
			}),
		)
		const a = model.entities.get("a")
		if (a === undefined) throw new Error("the document has an a")
		/* Entities as the model could make them: one created only, under a; one with no route at all. */
		const { create: _create, list: _list, ...routeless } = a
		const b = { ...routeless, create: "b.create", name: "b" }
		const ghost = { ...routeless, name: "ghost" }
		expect(names(entityLanes(model, [a, b, ghost]))).toEqual([["a", "b"], ["ghost"]])
	})

	it("ignores a link to an entity outside the queue", () => {
		const model = modelOf(docOf({ "/a": list("a.list", { "x-invalidate": ["GET /b"] }), "/b": list("b.list") }))
		const onlyA = [...model.entities.values()].filter((entity) => entity.name === "a")
		expect(names(entityLanes(model, onlyA))).toEqual([["a"]])
	})
})

describe("runLanes", () => {
	it("tests every entity, and reads the result in plan order", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		await runLanes(ctx)
		expect(ctx.state.entitiesTested).toEqual(["note"])
		expect(ctx.progress.entityTotal).toBe(1)
		expect(ctx.progress.entityIndex).toBe(1)
	})

	it("reports an entity that stopped on an unexpected error, and carries on", async () => {
		const ctx = await contextOf(
			optionsFor(notesApi(), {
				hooks: {
					resolveQueryCapabilities: async () => {
						throw new Error("hook broke")
					},
				},
			}),
		)
		await runLanes(ctx)
		expect(ctx.findings.findings).toEqual([
			expect.objectContaining({
				check: "run.error",
				entity: "note",
				summary: 'testing "note" stopped on an unexpected error',
			}),
		])
	})

	it("reads entities and findings in plan order, a stop's own finding after them", async () => {
		const controller = new AbortController()
		const nested = notesDoc({
			"/notes/{note_id}/tags": { get: { ...list("tag.list").get, parameters: [param("note_id")] } },
			"/zeta": list("zeta.list"),
		})
		const ctx = await contextOf(
			optionsFor(notesApi(nested), {
				hooks: {
					resolveQueryCapabilities: async ({ entity }) => {
						if (entity === "note") controller.abort()
						throw new Error(`${entity} hook broke`)
					},
				},
				signal: controller.signal,
			}),
		)
		await runLanes(ctx)
		expect(ctx.findings.findings.map((finding) => finding.entity)).toEqual(["note", "zeta", "run"])
	})
})

describe("runLanes stopping", () => {
	it("stops before the next entity when the run is interrupted, saying how many were left", async () => {
		const controller = new AbortController()
		controller.abort()
		const ctx = await contextOf(
			optionsFor(notesApi(notesDoc({ "/tags": list("tag.list") })), { signal: controller.signal }),
		)
		await runLanes(ctx)
		expect(ctx.state.interrupted).toBe(true)
		expect(ctx.findings.findings).toEqual([
			expect.objectContaining({ check: "run.interrupted", summary: "stopped before 2 remaining entities" }),
		])
	})

	it("skips what is left once the network is gone for good", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		await ctx.network.gate.awaitRecovery(Object.assign(new Error("x"), { kind: "dns" }) as never)
		await runLanes(ctx)
		expect(ctx.findings.findings).toEqual([
			expect.objectContaining({ check: "net.unreachable", summary: "skipped 1 remaining entity", verdict: "BLOCKED" }),
		])
	})
})

/* Notes and memos: two collections alike in every route, each in a lane of its own, one write path. */
const twins = (): ReturnType<typeof notesApi> => {
	const { paths } = notesDoc() as unknown as { paths: unknown }
	const doc = notesDoc(JSON.parse(JSON.stringify(paths).replaceAll("note", "memo")) as Record<string, unknown>)
	const notes = notesApi(doc)
	const memos = notesApi(doc)
	return (method, path, options) =>
		path.startsWith("/memos")
			? memos(method, path.replace(/^\/memos/, "/notes"), options)
			: notes(method, path, options)
}

const nothing = (): void => undefined
const collection = (name: string | undefined): string => (name === "note" ? "/notes" : "/memos")

describe("runLanes and the payload catalog", () => {
	it("runs the whole catalog on the first entity in plan order, however late its lane reaches it", async () => {
		const respond = twins()
		/* Each entity's collection, by its plan position: set once the plan is known. */
		const lane = { first: "", second: "" }
		let release = nothing
		const released = new Promise<void>((resolve) => {
			release = resolve
		})
		let armed = false
		let controlWritten = false
		const { fetch: inner } = transport(respond)
		/* The plan's first entity waits until the second has read back its ASCII control write: the
		 * moment before the second asks whether the write path has had the whole catalog. */
		const gated = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const { pathname } = new URL(String(input))
			if (armed && pathname.startsWith(lane.first)) await released
			const response = await inner(input, init)
			if (armed && pathname.startsWith(`${lane.second}/`)) {
				const method = init?.method ?? "GET"
				if (method === "PATCH" && String(init?.body).includes(ASCII_PAYLOAD_PROBE)) controlWritten = true
				else if (method === "GET" && controlWritten) release()
			}
			return response
		}
		const ctx = await contextOf(optionsFor(respond, { network: { fetch: gated as typeof fetch } }))
		const [first, second] = ctx.scope.entities.map((entity) => entity.name)
		expect([first, second].toSorted()).toEqual(["memos", "note"])
		lane.first = collection(first)
		lane.second = collection(second)
		armed = true
		await runLanes(ctx)
		expect(ctx.findings.findings.filter((finding) => finding.check === "payload.string-survives")).toEqual([
			expect.objectContaining({
				detail: expect.stringContaining(`already ran against this write path on ${first},`),
				entity: second,
				verdict: "COVERAGE_GAP",
			}),
		])
	})
})

describe("runLanes when the plan's first entity never reaches the payload path", () => {
	/* The timeout is the hang detector: an entity waiting on a claim that never settles would stop here. */
	it(
		"gives the whole catalog to the next entity when the plan's first one never reaches the path",
		{ timeout: 15_000 },
		async () => {
			const respond = twins()
			const lane = { first: "", second: "" }
			let armed = false
			const writes: string[] = []
			const { fetch: inner } = transport(respond)
			/* Every request of the plan's first entity fails, so its lane ends without claiming the path. */
			const failing = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const { pathname } = new URL(String(input))
				if (armed && pathname.startsWith(lane.first)) throw new TypeError("fetch failed")
				if (armed && pathname.startsWith(`${lane.second}/`) && init?.method === "PATCH") writes.push(String(init.body))
				return inner(input, init)
			}
			const ctx = await contextOf(optionsFor(respond, { network: { fetch: failing as typeof fetch } }))
			const [first, second] = ctx.scope.entities.map((entity) => entity.name)
			lane.first = collection(first)
			lane.second = collection(second)
			armed = true
			await runLanes(ctx)
			const payload = ctx.findings.findings.filter((finding) => finding.check === "payload.string-survives")
			expect(payload.filter((finding) => finding.detail.includes("already ran against this write path"))).toEqual([])
			expect(writes.some((body) => body.includes(ASCII_PAYLOAD_PROBE))).toBe(true)
		},
	)
})
