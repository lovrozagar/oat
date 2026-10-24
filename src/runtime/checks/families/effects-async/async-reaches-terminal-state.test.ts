import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CheckContext, Listed } from "../../core/context.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { ASSERTED } from "../../../finding.ts"
import { type Answer, contextFor, modelOf, op, type Responder } from "../../__fixtures__/harness.ts"
import {
	baseDocument,
	eachFixture,
	featureGateDenial,
	type Handler,
	routes,
	withBody,
	withOperation,
} from "./__fixtures__/documents.ts"
import { asyncReachesTerminalState as check } from "./async-reaches-terminal-state.ts"

const lifecycle = { idFrom: "$.id", poll: "getJob", pollIntervalMs: 1, successWhen: "result.eq.ok", timeoutMs: 40 }
const doc = withOperation(baseDocument(), "post /jobs", {
	operationId: "startJob",
	requestBody: withBody,
	"x-async": { ...lifecycle, until: "status.eq.done" },
})
withOperation(doc, "post /loose", {
	operationId: "startLoose",
	"x-async": { idFrom: "$.id", poll: "GET /jobs/{id}", pollIntervalMs: 1, timeoutMs: 20 },
})
withOperation(doc, "post /inbox-jobs", {
	operationId: "startInboxJob",
	"x-async": { poll: "GET /inbox", pollIntervalMs: 1, timeoutMs: 40, until: "status.eq.done" },
})
withOperation(doc, "post /gated", { operationId: "startGated", "x-async": lifecycle, "x-feature-gate": "pro" })
const model = modelOf(doc)
const startJob = op(model, "startJob")

const done = { body: { result: "ok", status: "done" }, status: 200 }
const pending = { body: { status: "pending" }, status: 200 }

/** Answers each poll in turn, repeating the last answer, each after 45ms of real time: a slow host. */
function polls(...answers: ReturnType<Handler>[]): Handler {
	let at = 0
	return () => {
		stall(45)
		return answers[Math.min(at++, answers.length - 1)]
	}
}

/* Blocks the thread for `ms` of real time, which no fake timer shortens. */
function stall(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/* The poll budget is virtual time: a run's verdict never depends on how fast the host is. */
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
})
afterEach(() => {
	vi.useRealTimers()
})

async function watched(respond: Responder, asyncOps: OperationModel[] = [startJob], fields: Partial<Listed> = {}) {
	const recordCreated = vi.fn<NonNullable<CheckContext["recordCreated"]>>()
	const recordUnidentified = vi.fn<NonNullable<CheckContext["recordUnidentified"]>>()
	const stage = contextFor(model, "listWidgets", {
		respond,
		fields: { asyncOps, recordCreated, recordUnidentified, ...fields },
	})
	const running = check.run(stage.ctx, undefined)
	await vi.runAllTimersAsync()
	return { ...stage, outcome: await running, recordCreated, recordUnidentified }
}

const started = (poll: Handler, start: Answer = { body: { id: "j1" }, status: 202 }): Responder =>
	routes({ "GET /jobs/j1": poll, "POST /jobs": () => start })

const plan = (asyncOps: OperationModel[]) =>
	check.plan(contextFor(model, "listWidgets", { respond: () => undefined, fields: { asyncOps } }).ctx).ok

describe("plan", () => {
	it("applies when some operation declares x-async", () => {
		expect(plan([])).toBe(false)
		expect(plan([startJob])).toBe(true)
	})
})

describe("a polled job", () => {
	it("passes a job that reaches a successful terminal state, and records the job for removal", async () => {
		const run = await watched(started(polls(pending, done)))
		expect(run.outcome).toBe(ASSERTED)
		expect(run.findings.findings).toEqual([])
		expect(run.findings.inconclusive).toEqual([])
		expect(run.sent.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /jobs", "GET /jobs/j1", "GET /jobs/j1"])
		expect(run.sent[0]?.options.body).toMatchObject({ name: expect.any(String) })
		expect(run.recordCreated).toHaveBeenCalledWith({ entity: "job", id: "j1", scope: {} }, "alpha")
	})

	it("fails a job that never reaches a terminal state, with the start and the last polls as evidence", async () => {
		const run = await watched(started(polls(pending)))
		const [finding] = run.findings.findings
		expect(finding).toMatchObject({ summary: "startJob never reached a terminal state", verdict: "BACKEND_BUG" })
		expect(finding?.detail).toContain('without satisfying "status.eq.done"')
		expect(finding?.evidence.map((e) => e.method)).toEqual(["POST", "GET", "GET"])
	})

	it("names any terminal state when no `until` is declared, polling a route spelled as one", async () => {
		const respond = routes({
			"GET /jobs/j1": () => ({ status: 500 }),
			"POST /loose": () => ({ body: { id: "j1" }, status: 202 }),
		})
		const run = await watched(respond, [op(model, "startLoose")])
		expect(run.findings.findings[0]?.detail).toContain('without satisfying "any terminal state"')
		expect(run.recordCreated).toHaveBeenCalledWith({ entity: "job", id: "j1", scope: {} }, "alpha")
	})

	it("fails a job the poll route stops serving", async () => {
		const run = await watched(started(polls(pending, { status: 404 })))
		expect(run.findings.findings).toMatchObject([
			{ summary: "startJob job disappeared before completing", verdict: "BACKEND_BUG" },
		])
		expect(run.findings.findings[0]?.detail).toContain("after 2 poll(s)")
	})

	it("reports a job that ended in a non-success state as untested downstream", async () => {
		const run = await watched(started(polls({ body: { result: "error", status: "done" }, status: 200 })))
		expect(run.findings.findings).toMatchObject([
			{ summary: "startJob reached a non-success terminal state", verdict: "COVERAGE_GAP" },
		])
		expect(run.findings.findings[0]?.detail).toContain('did not satisfy "result.eq.ok"')
	})
})

describe("a polled job's record", () => {
	it("records a receipt without an id as unidentified, and cannot name the job to poll", async () => {
		const run = await watched(started(polls(done), { body: {}, status: 202 }))
		expect(run.recordUnidentified).toHaveBeenCalledWith("job", "startJob", expect.objectContaining({ status: 202 }))
		expect(run.recordCreated).not.toHaveBeenCalled()
		expect(run.findings.inconclusive[0]?.reason).toMatch(
			/^the poll route getJob could not be filled from the receipt: /,
		)
		expect(run.sent).toHaveLength(1)
	})

	it("records nothing when the poll route belongs to no entity", async () => {
		const respond = routes({ "GET /inbox": () => done, "POST /inbox-jobs": () => ({ body: {}, status: 202 }) })
		const run = await watched(respond, [op(model, "startInboxJob")])
		expect(run.findings.findings).toEqual([])
		expect(run.recordCreated).not.toHaveBeenCalled()
		expect(run.recordUnidentified).not.toHaveBeenCalled()
	})

	it("starts the job as the actor, and polls as the actor continuing from the start", async () => {
		const run = await watched(started(polls(done)))
		const [start, poll] = run.sent.map((sent) => sent.options.as)
		expect(start).toEqual({ principal: "alpha" })
		expect(poll).toEqual({ principal: "alpha", via: expect.objectContaining({ method: "POST", status: 202 }) })
	})
})

describe("a start that began no job", () => {
	it.each([
		[0, "startJob answered nothing, so no job was started to watch"],
		[503, "startJob answered 503, so no job was started to watch"],
	])("is unresolved when the start answered %s", async (status, reason) => {
		const run = await watched(started(polls(done), { body: {}, status }))
		expect(run.findings.inconclusive).toMatchObject([{ check: check.id, reason }])
		expect(run.sent).toHaveLength(1)
	})

	it("is a coverage gap when the start was refused", async () => {
		const run = await watched(started(polls(done), { body: {}, status: 422 }))
		expect(run.findings.findings).toMatchObject([
			{ detail: "returned 422; the async lifecycle after it is untested", summary: "startJob could not be started" },
		])
	})

	it("stands down on a documented feature-gate denial", async () => {
		const run = await watched(routes({ "POST /gated": () => featureGateDenial }), [op(model, "startGated")])
		expect(run.findings.findings).toMatchObject([{ summary: "startGated did not apply", verdict: "COVERAGE_GAP" }])
		expect(run.sent).toHaveLength(1)
	})

	it("skips an operation that declares no x-async", async () => {
		const run = await watched(() => done, [op(model, "createWidget")])
		expect(run.sent).toEqual([])
	})
})

const stream = (body: string, opId = startJob) =>
	watched(() => ({ body, headers: { "content-type": "text/event-stream" }, status: 200 }), [opId])

describe("a streamed start", () => {
	it("passes a stream that ends in a successful terminal frame, without polling", async () => {
		const run = await stream('event: complete\ndata: {"id":"j1","result":"ok"}\n\n')
		expect(run.findings.findings).toEqual([])
		expect(run.sent).toHaveLength(1)
	})

	it("reports a stream that ends in a failed terminal frame", async () => {
		const run = await stream('event: error\ndata: {"id":"j1","result":"boom"}\n\n')
		expect(run.findings.findings).toMatchObject([{ summary: "startJob reached a non-success terminal state" }])
	})

	it("accepts any terminal frame when no success predicate is declared", async () => {
		const { successWhen: _, ...lenient } = lifecycle
		const run = await stream('event: complete\ndata: {"result":"boom"}\n\n', {
			...startJob,
			async: { ...lenient, until: "status.eq.done" },
		})
		expect(run.findings.findings).toEqual([])
	})

	it("fails a stream that ends with neither a terminal frame nor a job id", async () => {
		const run = await stream('event: progress\ndata: {"pct":50}\n\n')
		expect(run.findings.findings).toMatchObject([
			{ evidence: [{ status: 200 }], summary: "startJob job disappeared before completing", verdict: "BACKEND_BUG" },
		])
	})

	it("polls the job a frame named when the stream ends early", async () => {
		const respond = routes({
			"GET /jobs/j1": () => done,
			"POST /jobs": () => ({
				body: 'event: progress\ndata: {"id":"j1"}\n\n',
				headers: { "content-type": "text/event-stream" },
				status: 200,
			}),
		})
		const run = await watched(respond)
		expect(run.findings.findings).toEqual([])
		expect(run.sent.map((s) => s.path)).toEqual(["/jobs", "/jobs/j1"])
	})

	it("polls from the response itself when a stream-typed body is not a stream", async () => {
		const respond = started(polls(done), { body: { id: "j1" }, status: 200 })
		const run = await watched(respond, [{ ...startJob, eventStream: true }])
		expect(run.sent.map((s) => s.path)).toEqual(["/jobs", "/jobs/j1"])
	})
})

describe("each fixture", () => {
	it("names the fixture in the subject and on the finding", async () => {
		const run = await watched(started(polls(done), { body: {}, status: 422 }), [startJob], {
			uploads: eachFixture("startJob"),
		})
		expect(run.findings.findings).toMatchObject([{ entity: "startJob · documents.ts", fixture: "documents.ts" }])
	})
})

describe("a polled job that settles past its budget", () => {
	it("notes a job that finished only after its budget, so a slow host stays visible", async () => {
		const slowly = polls(pending, done)
		const run = await watched(
			started((...request) => {
				vi.advanceTimersByTime(50)
				return slowly(...request)
			}),
		)
		expect(run.findings.findings).toEqual([])
		expect(run.outcome).toEqual({
			kind: "asserted",
			note: expect.stringMatching(
				/^startJob waited \d+ms for x-async, over its \d+ms budget; the host or the server is slow$/,
			),
		})
	})
})
