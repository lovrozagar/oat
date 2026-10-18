import { describe, expect, it, vi } from "vitest"
import type { EntityModel, OperationModel, SpecModel } from "../../../../spec/graph/types.ts"
import { ASSERTED } from "../../../finding.ts"
import { type Answer, contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import type { CheckContext } from "../../core/context.ts"
import {
	baseDocument,
	eachFixture,
	featureGateDenial,
	type Handler,
	routes,
	withBody,
	withOperation,
} from "./__fixtures__/documents.ts"
import { declaredEffectsOccur as check } from "./effects-declared-effect-occurs.ts"

const clones = [{ entity: "widget", op: "create" }]
const doc = withOperation(baseDocument(), "post /widgets/{id}/clone", {
	operationId: "cloneWidget",
	requestBody: withBody,
	"x-effects": clones,
})
withOperation(doc, "post /widgets/{id}/copy", { operationId: "copyWidget", "x-effects": clones })
withOperation(doc, "post /widgets/{id}/quiet", { operationId: "quietWidget", "x-effects": [] })
withOperation(doc, "post /widgets/{id}/parts/{part_id}/act", {
	operationId: "actOnPart",
	"x-effects": [{ entity: "widget", op: "update" }],
})
withOperation(doc, "post /gated/{id}", { operationId: "gatedClone", "x-effects": clones, "x-feature-gate": "pro" })
const tagged = (operationId: string, before: string) =>
	withOperation(doc, `post /widgets/{id}/${operationId}`, {
		operationId,
		"x-before": before,
		"x-bind": { query: { board: "before:$.id" } },
		"x-effects": [{ entity: "widget", op: "update" }],
	})
tagged("tagWidget", "createBoard")
tagged("pinWidget", "nowhere")
tagged("cardWidget", "getCard")
tagged("noteWidget", "createCard")
tagged("readWidget", "getInbox")
withOperation(doc, "post /widgets/{id}/audit", {
	operationId: "auditWidget",
	"x-effects": [
		{ entity: "job", op: "create" },
		{ entity: "widget", op: "update" },
		{ entity: "widget", op: "update" },
	],
})
const model = modelOf(doc)

/** A widget collection holding w1, whose actions add a widget when `adds` says they do. */
function widgets(action: Answer = { body: {}, status: 200 }, adds = true, more: Record<string, Handler> = {}) {
	const held = ["w1"]
	const act = () => {
		if (adds && action.status < 400) held.push(`w${held.length + 1}`)
		return action
	}
	return routes({
		"GET /widgets": () => ({ body: held.map((id) => ({ id, name: id })), status: 200 }),
		"POST /widgets/w1/clone": act,
		"POST /widgets/w1/copy": act,
		...more,
	})
}

async function occurred(respond: Responder, ids: string[], fields: Partial<CheckContext> = {}) {
	const recordCreated = vi.fn<NonNullable<CheckContext["recordCreated"]>>()
	const recordUnidentified = vi.fn<NonNullable<CheckContext["recordUnidentified"]>>()
	const effectOps = ids.map((id): OperationModel => op(model, id))
	const stage = contextFor(model, "listWidgets", {
		respond,
		fields: {
			effectOps,
			recordCreated,
			recordUnidentified,
			records: [{ id: "w1", name: "w1" }],
			...fields,
		},
	})
	const outcome = await check.run(stage.ctx, undefined)
	const calls = stage.sent.map((s) => `${s.method} ${s.path}`)
	return { ...stage, calls, outcome, recordCreated, recordUnidentified }
}

describe("plan", () => {
	it("applies when some operation declares x-effects", () => {
		const plan = (effectOps: OperationModel[]) =>
			check.plan(contextFor(model, "listWidgets", { respond: () => undefined, fields: { effectOps } }).ctx).ok
		expect(plan([])).toBe(false)
		expect(plan([op(model, "cloneWidget")])).toBe(true)
	})
})

describe("an action that succeeds", () => {
	it("passes when the declared record appears, reading the collection before and after", async () => {
		const run = await occurred(widgets(), ["cloneWidget"])
		expect(run.outcome).toBe(ASSERTED)
		expect(run.findings.findings).toEqual([])
		expect(run.calls).toEqual(["GET /widgets", "POST /widgets/w1/clone", "GET /widgets"])
		expect(run.sent[1]?.options).toMatchObject({ operationId: "cloneWidget" })
		expect(run.sent[1]?.options.body).toMatchObject({ name: expect.any(String) })
		expect(run.recordCreated).toHaveBeenCalledWith({ entity: "widget", id: "w2", scope: { id: "w1" } }, undefined)
	})

	it("fails when the declared record never appears", async () => {
		const run = await occurred(widgets({ body: {}, status: 200 }, false), ["cloneWidget"])
		expect(run.outcome).toBe(ASSERTED)
		expect(run.findings.findings).toMatchObject([
			{
				operations: ["cloneWidget"],
				summary: 'cloneWidget did not produce the "widget" records it declares',
				verdict: "BACKEND_BUG",
			},
		])
	})

	it("reads the instance as it is now before binding the action", async () => {
		const respond = widgets({ body: {}, status: 200 }, true, {
			"GET /widgets/w1": () => ({ body: { id: "w1", name: "now" }, status: 200 }),
		})
		const run = await occurred(respond, ["copyWidget"], { readOp: op(model, "getWidget") })
		expect(run.calls).toEqual(["GET /widgets/w1", "GET /widgets", "POST /widgets/w1/copy", "GET /widgets"])
		expect(run.sent[2]?.options).not.toHaveProperty("body")
	})

	it("sends and names the fixture when uploads.each drives the action", async () => {
		const run = await occurred(widgets({ status: 422 }), ["cloneWidget"], { uploads: eachFixture("cloneWidget") })
		expect(run.sent[1]?.options).toMatchObject({ fixture: "documents.ts" })
		expect(run.findings.findings).toMatchObject([{ entity: "cloneWidget · documents.ts", fixture: "documents.ts" }])
	})
})

describe("an action that does not succeed", () => {
	it("is a gap when refused, and the run stays asserted: the request was more likely oat's", async () => {
		const run = await occurred(widgets({ status: 422 }), ["cloneWidget"])
		expect(run.findings.findings).toMatchObject([
			{ detail: "returned 422; its declared effects are unverified", summary: "cloneWidget could not be invoked" },
		])
		expect(run.outcome).toBe(ASSERTED)
		expect(run.calls).toEqual(["GET /widgets", "POST /widgets/w1/clone"])
	})

	it("leaves the check unresolved when every action crashed, naming the first", async () => {
		const run = await occurred(widgets({ status: 500 }), ["cloneWidget", "copyWidget"])
		const reason = "cloneWidget returned 500, so its declared effects were never observed"
		expect(run.outcome).toEqual({ kind: "unresolved", reason })
		expect(run.findings.inconclusive).toEqual([{ check: check.id, entity: "widget", reason }])
	})

	it("stays asserted when another action was judged after one crashed", async () => {
		const respond = widgets({ body: {}, status: 200 }, true, { "POST /widgets/w1/clone": () => ({ status: 500 }) })
		const run = await occurred(respond, ["cloneWidget", "copyWidget"])
		expect(run.outcome).toBe(ASSERTED)
	})

	it("stands down on a rate limit and on a documented feature gate", async () => {
		const respond = widgets({ status: 429 }, false, { "POST /gated/w1": () => featureGateDenial })
		const run = await occurred(respond, ["cloneWidget", "gatedClone"])
		expect(run.outcome).toBe(ASSERTED)
		expect(run.findings.inconclusive.map((i) => i.reason)).toEqual([
			"the request was rate-limited (429) after retries, so this check could not complete",
		])
		expect(run.findings.findings).toMatchObject([{ summary: "gatedClone did not apply" }])
	})

	it("is a gap naming the path parameters the action cannot be given, and sends nothing", async () => {
		const run = await occurred(widgets(), ["actOnPart"])
		expect(run.findings.findings).toMatchObject([
			{ detail: "missing {part_id}", summary: "actOnPart could not be invoked", verdict: "COVERAGE_GAP" },
		])
		expect(run.sent).toEqual([])
	})

	it("sends nothing for an action that declares no effects", async () => {
		const run = await occurred(widgets(), ["quietWidget"])
		expect(run.sent).toEqual([])
		expect(run.findings.findings).toEqual([])
	})
})

const tag = (board: Answer, more: Record<string, Handler> = {}) =>
	widgets({ body: {}, status: 200 }, false, {
		"POST /boards": () => board,
		"POST /widgets/w1/tagWidget": () => ({ body: {}, status: 200 }),
		...more,
	})

describe("an x-before prelude", () => {
	it("runs first, feeds the action's x-bind, and its created record is the run's to remove", async () => {
		const run = await occurred(tag({ body: { id: "b1", name: "b" }, status: 201 }), ["tagWidget"])
		expect(run.calls).toEqual(["POST /boards", "GET /widgets", "POST /widgets/w1/tagWidget", "GET /widgets"])
		expect(run.sent[0]?.options.body).toMatchObject({ name: expect.any(String) })
		expect(run.sent[2]?.options.query).toEqual({ board: "b1" })
		expect(run.recordCreated).toHaveBeenCalledWith({ entity: "board", id: "b1", scope: { id: "w1" } }, undefined)
		expect(run.findings.findings).toEqual([])
	})

	it("records a created record it cannot identify as unidentified", async () => {
		const run = await occurred(tag({ body: {}, status: 201 }), ["tagWidget"])
		expect(run.recordUnidentified).toHaveBeenCalledWith(
			"board",
			"createBoard",
			expect.objectContaining({ status: 201 }),
		)
		expect(run.sent[2]?.options).not.toHaveProperty("query")
	})

	it("records nothing for a prelude that is not a create, did not answer 2xx, or makes what cannot be removed", async () => {
		const respond = tag(
			{ body: { id: "b1" }, status: 304 },
			{
				"GET /inbox": () => ({ body: { id: "i1" }, status: 200 }),
				"POST /boards/b1/cards": () => ({ body: { id: "c1" }, status: 201 }),
			},
		)
		const run = await occurred(respond, ["tagWidget", "readWidget", "noteWidget"], {
			records: [{ board_id: "b1", id: "w1", name: "w1" }],
		})
		expect(run.calls).toContain("GET /inbox")
		expect(run.calls).toContain("POST /boards/b1/cards")
		expect(run.recordCreated).not.toHaveBeenCalled()
		expect(run.recordUnidentified).not.toHaveBeenCalled()
	})
})

describe("baselines", () => {
	it("reads each listed entity's collection once before the action, and none without a list", async () => {
		const run = await occurred(widgets(undefined, false, { "POST /widgets/w1/audit": () => ({ status: 200 }) }), [
			"auditWidget",
		])
		expect(run.calls).toEqual(["GET /widgets", "POST /widgets/w1/audit", "GET /widgets", "GET /widgets"])
		expect(run.findings.findings.map((f) => f.summary)).toEqual([
			'auditWidget declares an effect on "job", which has no list route',
		])
	})
})

/** The model, with the prelude create `createBoard` or the board entity changed. */
function variant(change: { entity?: null; identity?: null }): SpecModel {
	const createBoard = op(model, "createBoard")
	const board = { ...model.entities.get("board"), ...change } as EntityModel
	return {
		...model,
		byOperationId: new Map(model.byOperationId).set("createBoard", { ...createBoard, ...change }),
		entities: new Map(model.entities).set("board", board),
	}
}

describe("a prelude create the model describes partly", () => {
	it("records nothing for a create that names no entity", async () => {
		const run = await occurred(tag({ body: { id: "b1" }, status: 201 }), ["tagWidget"], {
			model: variant({ entity: null }),
		})
		expect(run.recordCreated).not.toHaveBeenCalled()
		expect(run.recordUnidentified).not.toHaveBeenCalled()
	})

	it("reads the created id from `id` for an entity with no identity", async () => {
		const run = await occurred(tag({ body: { id: "b1" }, status: 201 }), ["tagWidget"], {
			model: variant({ identity: null }),
		})
		expect(run.recordCreated).toHaveBeenCalledWith({ entity: "board", id: "b1", scope: { id: "w1" } }, undefined)
	})
})

describe("an x-before prelude that cannot run", () => {
	it("is a gap, and the action is not invoked, when the prelude is refused", async () => {
		const run = await occurred(tag({ status: 409 }), ["tagWidget"])
		expect(run.findings.findings).toMatchObject([
			{ detail: "tagWidget was not invoked", summary: "createBoard (x-before) returned 409" },
		])
		expect(run.calls).toEqual(["POST /boards"])
	})

	it("is a gap when it names no operation, or one whose path cannot be filled", async () => {
		const run = await occurred(widgets(), ["pinWidget", "cardWidget"])
		expect(run.findings.findings.map((f) => [f.summary, f.detail])).toEqual([
			['pinWidget names x-before "nowhere", which is not an operation', "the action was not invoked"],
			['cardWidget could not run x-before "getCard"', "missing {board_id}, {card_id}"],
		])
		expect(run.sent).toEqual([])
	})
})
