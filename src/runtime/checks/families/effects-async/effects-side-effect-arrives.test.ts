import { describe, expect, it, vi } from "vitest"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { ASSERTED } from "../../../finding.ts"
import { contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import type { CheckContext } from "../../core/context.ts"
import {
	baseDocument,
	eachFixture,
	featureGateDenial,
	routes,
	withBody,
	withOperation,
} from "./__fixtures__/documents.ts"
import { sideEffectArrives as check } from "./effects-side-effect-arrives.ts"

const quick = { pollIntervalMs: 1, timeoutMs: 25 }
const doc = withOperation(baseDocument(), "post /notes", {
	operationId: "sendNote",
	requestBody: withBody,
	"x-wait": { ...quick, operationId: "getInbox", until: "$.items" },
})
withOperation(doc, "post /bare-notes", { operationId: "sendBare", "x-wait": { ...quick, operationId: "getInbox" } })
withOperation(doc, "post /letters", { operationId: "sendLetter", "x-wait": { ...quick, operationId: "getMailbox" } })
withOperation(doc, "get /mailboxes/{mailbox_id}", { operationId: "getMailbox" })
withOperation(doc, "post /board-requests", {
	operationId: "requestBoard",
	"x-effects": [{ entity: "board", op: "create" }],
	"x-wait": { ...quick, operationId: "getBoard" },
})
withOperation(doc, "post /lost", { operationId: "sendLost", "x-wait": { operationId: "nowhere" } })
withOperation(doc, "post /gated-notes", {
	operationId: "sendGated",
	"x-feature-gate": "pro",
	"x-wait": { ...quick, operationId: "getInbox" },
})
const model = modelOf(doc)
const sendNote = op(model, "sendNote")

async function waited(respond: Responder, waitOps: OperationModel[] = [sendNote], fields: Partial<CheckContext> = {}) {
	const stage = contextFor(model, "listWidgets", { respond, fields: { waitOps, ...fields } })
	const outcome = await check.run(stage.ctx, undefined)
	return { ...stage, outcome }
}

const delivered = { body: { items: ["n1"] }, status: 200 }
const empty = { body: { items: [] }, status: 200 }

const plan = (waitOps: OperationModel[]) =>
	check.plan(contextFor(model, "listWidgets", { respond: () => undefined, fields: { waitOps } }).ctx).ok

describe("plan", () => {
	it("applies when some operation declares x-wait", () => {
		expect(plan([])).toBe(false)
		expect(plan([sendNote])).toBe(true)
	})
})

describe("a write whose side effect is polled", () => {
	it("passes a side effect that arrives, after sending the write's body", async () => {
		let polled = 0
		const respond = routes({
			"GET /inbox": () => (polled++ < 2 ? empty : delivered),
			"POST /notes": () => ({ body: {}, status: 201 }),
		})
		const run = await waited(respond)
		expect(run.outcome).toBe(ASSERTED)
		expect(run.findings.findings).toEqual([])
		expect(run.sent.map((s) => `${s.method} ${s.path}`)).toEqual([
			"POST /notes",
			"GET /inbox",
			"GET /inbox",
			"GET /inbox",
		])
		expect(run.sent[0]?.options).toMatchObject({ operationId: "sendNote" })
		expect(run.sent[0]?.options.body).toMatchObject({ name: expect.any(String) })
	})

	it("fails a side effect that never arrives, with the write and the last polls as evidence", async () => {
		const run = await waited(routes({ "GET /inbox": () => empty, "POST /notes": () => ({ body: {}, status: 201 }) }))
		const [finding] = run.findings.findings
		expect(finding).toMatchObject({
			check: "effects.side-effect-arrives",
			operations: ["sendNote"],
			summary: "sendNote side effect did not appear within 25ms",
			verdict: "BACKEND_BUG",
		})
		expect(finding?.detail).toMatch(/^x-wait polls getInbox until \$\.items is non-empty and the path was still empty/)
		expect(finding?.evidence.map((e) => e.method)).toEqual(["POST", "GET", "GET"])
	})

	it("describes the wait without a path when none is declared", async () => {
		const run = await waited(
			routes({ "GET /inbox": () => ({ status: 500 }), "POST /bare-notes": () => ({ status: 201 }) }),
			[op(model, "sendBare")],
		)
		expect(run.findings.findings[0]?.detail).toMatch(/^x-wait polls getInbox and the path was still empty/)
	})
})

describe("polling hooks", () => {
	it("lets the awaitSideEffect hook decide the effect arrived", async () => {
		const awaitSideEffect = vi.fn<() => Promise<true | null>>(async () => true)
		const run = await waited(
			routes({ "GET /inbox": () => empty, "POST /notes": () => ({ status: 201 }) }),
			[sendNote],
			{
				hooks: { awaitSideEffect },
			},
		)
		expect(run.findings.findings).toEqual([])
		expect(awaitSideEffect).toHaveBeenCalledWith({ attempt: 1, operationId: "sendNote", record: { items: [] } })
	})

	it("refreshes a stale credential while it polls", async () => {
		const refreshIfStale = vi.fn<NonNullable<CheckContext["refreshIfStale"]>>(async () => undefined)
		await waited(routes({ "GET /inbox": () => delivered, "POST /notes": () => ({ status: 201 }) }), [sendNote], {
			refreshIfStale,
		})
		expect(refreshIfStale).toHaveBeenCalled()
	})
})

describe("the poll path", () => {
	it("fills the poll path from the write's response", async () => {
		const respond = routes({
			"GET /mailboxes/m1": () => delivered,
			"POST /letters": () => ({ body: { mailbox_id: "m1" }, status: 201 }),
		})
		const run = await waited(respond, [op(model, "sendLetter")])
		expect(run.findings.findings).toEqual([])
		expect(run.sent.map((s) => s.path)).toEqual(["/letters", "/mailboxes/m1"])
	})

	it("fills the poll path with the id of a record the write declares it creates", async () => {
		const respond = routes({
			"GET /boards/b1": () => delivered,
			"POST /board-requests": () => ({ body: { id: "b1" }, status: 201 }),
		})
		const run = await waited(respond, [op(model, "requestBoard")])
		expect(run.sent.map((s) => s.path)).toEqual(["/board-requests", "/boards/b1"])
	})
})

describe("a write that cannot be judged", () => {
	it("is a coverage gap when x-wait names an operation the document lacks", async () => {
		const run = await waited(() => undefined, [op(model, "sendLost")])
		expect(run.findings.findings).toMatchObject([
			{
				detail: "the side effect cannot be observed, so it is not verified",
				summary: 'sendLost x-wait names "nowhere", which is not in the document',
				verdict: "COVERAGE_GAP",
			},
		])
		expect(run.sent).toEqual([])
	})

	it("is a coverage gap when the write is refused, and does not poll", async () => {
		const run = await waited(routes({ "POST /notes": () => ({ status: 400 }) }))
		expect(run.findings.findings).toMatchObject([
			{ detail: "returned 400; its declared x-wait is unverified", summary: "sendNote could not be invoked" },
		])
		expect(run.sent).toHaveLength(1)
	})

	it("stands down on a documented feature-gate denial", async () => {
		const run = await waited(routes({ "POST /gated-notes": () => featureGateDenial }), [op(model, "sendGated")])
		expect(run.findings.findings).toMatchObject([{ summary: "sendGated did not apply" }])
		expect(run.sent).toHaveLength(1)
	})

	it("stands down, unresolved, when the write stays rate-limited", async () => {
		const run = await waited(routes({ "POST /notes": () => ({ status: 429 }) }))
		expect(run.findings.findings).toEqual([])
		expect(run.findings.inconclusive).toMatchObject([{ check: check.id, reason: expect.stringContaining("429") }])
		expect(run.sent).toHaveLength(1)
	})

	it("skips an operation that declares no x-wait", async () => {
		const run = await waited(() => delivered, [op(model, "createWidget")])
		expect(run.sent).toEqual([])
	})

	it("sends and names the fixture when uploads.each drives the write", async () => {
		const run = await waited(routes({ "POST /notes": () => ({ status: 400 }) }), [sendNote], {
			uploads: eachFixture("sendNote"),
		})
		expect(run.sent[0]?.options).toMatchObject({ fixture: "documents.ts" })
		expect(run.findings.findings).toMatchObject([{ entity: "sendNote · documents.ts", fixture: "documents.ts" }])
	})
})
