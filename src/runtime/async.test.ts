import { describe, expect, it } from "vitest"
import { type Answer, json, transport } from "../client/__fixtures__/transport.ts"
import { Client } from "../client/client.ts"
import { fixedSource, sendingHeaders } from "../client/__fixtures__/source.ts"
import type { Exchange } from "./exchange.ts"
import { Redactor } from "../security/redact.ts"
import type { AsyncSpec } from "../spec/extensions/async.ts"
import { type AsyncDrive, driveAsync, inspectStreamAsync, matchesPredicate, resolveAsyncId } from "./async.ts"

describe("matchesPredicate", () => {
	const record = { done: true, gone: null, n: 1.5, off: false, status: "done" }

	it("speaks the filter grammar's eq, neq, in and is", () => {
		expect(matchesPredicate(record, "status.eq.done")).toBe(true)
		expect(matchesPredicate(record, "n.eq.1.5")).toBe(true)
		expect(matchesPredicate(record, "status.neq.done")).toBe(false)
		expect(matchesPredicate(record, "status.in.(queued, done)")).toBe(true)
		expect(matchesPredicate(record, "gone.is.null")).toBe(true)
		expect(matchesPredicate(record, "missing.is.null")).toBe(true)
		expect(matchesPredicate(record, "done.is.true")).toBe(true)
		expect(matchesPredicate(record, "off.is.false")).toBe(true)
	})

	it("is false for a short expression, an unknown operator, or an unknown is-value", () => {
		expect(matchesPredicate(record, "status.eq")).toBe(false)
		expect(matchesPredicate(record, "status.like.d")).toBe(false)
		expect(matchesPredicate(record, "done.is.maybe")).toBe(false)
	})
})

const STREAM = [
	"event: start",
	"data: not json",
	"",
	"event: progress",
	'data: {"note":"no id yet"}',
	"",
	"event: progress",
	'data: {"job":{"id":"j1"},"status":"running"}',
	"",
	"event: complete",
	'data: {"job":{"id":"j2"},"status":"done"}',
	"",
].join("\n")

describe("resolveAsyncId", () => {
	it("reads idFrom from a JSON receipt, or the first stream frame that carries it", () => {
		expect(resolveAsyncId({ job: { id: 7 } }, "$.job.id")).toBe(7)
		expect(resolveAsyncId(STREAM, "$.job.id")).toBe("j1")
		expect(resolveAsyncId(STREAM, "$.missing")).toBeUndefined()
	})
})

const streamSpec = (more: Partial<AsyncSpec> = {}): AsyncSpec => ({
	poll: "GET /jobs/{id}",
	pollIntervalMs: 1,
	timeoutMs: 1,
	...more,
})

describe("inspectStreamAsync", () => {
	it("is null for a body that is not a stream", () => {
		expect(inspectStreamAsync({ id: 1 }, streamSpec())).toBeNull()
	})

	it("takes the first frame's id and the last terminal frame, named or matching until", () => {
		const view = inspectStreamAsync(STREAM, streamSpec({ idFrom: "$.job.id" }))
		expect(view?.id).toBe("j1")
		expect(view?.idRecord).toEqual({ job: { id: "j1" }, status: "running" })
		expect(view?.terminal).toEqual({ job: { id: "j2" }, status: "done" })
		expect(view?.events).toHaveLength(4)
		const until = inspectStreamAsync(
			STREAM.replace("event: complete", "event: progress"),
			streamSpec({ until: "status.eq.running" }),
		)
		expect(until?.id).toBeUndefined()
		expect(until?.terminal).toEqual({ job: { id: "j1" }, status: "running" })
	})
})

/* The request that began the job, as the client recorded it. */
const START = { principal: "alpha", schemes: ["jwt"], seq: 1, status: 202 } as Exchange

/** A job store a poll reads: each route's answers in order, the last repeating. */
function drive(answer: Answer, more: Partial<Omit<AsyncDrive, "spec">> & { spec?: Partial<AsyncSpec> } = {}) {
	const wire = transport(answer)
	const source = fixedSource(sendingHeaders({ authorization: "Bearer t" }))
	const client = new Client({
		baseUrl: "http://api.test",
		credentials: source,
		network: { fetchImpl: wire.fetch },
		redactor: new Redactor(),
	})
	const { spec, ...rest } = more
	const outcome = driveAsync({
		client,
		principal: "alpha",
		receipt: { id: "job 1" },
		start: START,
		scope: {},
		spec: {
			idFrom: "$.id",
			poll: "GET /jobs/{id}",
			pollIntervalMs: 1,
			timeoutMs: 1_000,
			until: "status.eq.done",
			...spec,
		},
		...rest,
	})
	return { outcome, sent: wire.sent, source }
}

const answers =
	(...bodies: Array<[number, unknown]>): Answer =>
	(_sent, index) => {
		const [status, body] = bodies[Math.min(index, bodies.length - 1)] as [number, unknown]
		return json(body, status)
	}

describe("driveAsync, reaching a terminal state", () => {
	it("binds the receipt's id to the poll path and polls until until matches", async () => {
		const { outcome, sent } = drive(answers([200, "busy"], [200, { status: "running" }], [200, { status: "done" }]), {
			spec: { successWhen: "status.eq.done" },
		})
		expect(await outcome).toMatchObject({ polls: 3, state: "terminal", succeeded: true, terminal: { status: "done" } })
		expect(sent.map((request) => request.url)).toEqual(Array(3).fill("http://api.test/jobs/job%201"))
		expect(sent[0]?.headers.authorization).toBe("Bearer t")
	})

	it("names the successWhen a terminal state did not meet", async () => {
		const { outcome } = drive(answers([200, { status: "done" }]), { spec: { successWhen: "result.eq.ok" } })
		expect(await outcome).toMatchObject({ state: "terminal", succeeded: false, unmet: "result.eq.ok" })
	})

	it("takes the first object answer as terminal when nothing says when it ends", async () => {
		const { outcome } = drive(answers([200, { status: "queued" }]), { spec: { until: undefined } as never })
		expect(await outcome).toMatchObject({ polls: 1, state: "terminal", succeeded: true })
	})
})

const operation = (id: string) => (id === "job.get" ? { method: "post", path: "/jobs/{id}" } : undefined)

describe("driveAsync, choosing where to poll", () => {
	it("binds the id under idFrom's name when the poll path has no open parameter", async () => {
		const { outcome, sent } = drive(answers([200, { status: "done" }]), {
			scope: { id: "known" },
			spec: { poll: "GET /jobs/{id}/latest" },
		})
		await outcome
		expect(sent[0]?.url).toBe("http://api.test/jobs/job%201/latest")
		const plain = drive(answers([200, { status: "done" }]), { spec: { poll: "GET /jobs/current" } })
		await plain.outcome
		expect(plain.sent[0]?.url).toBe("http://api.test/jobs/current")
	})

	it("polls the operation poll names, and the caller's scope when the receipt names no job", async () => {
		const named = drive(answers([200, { status: "done" }]), {
			operation,
			receipt: {},
			scope: { id: "s1" },
			spec: { poll: "job.get" },
		})
		await named.outcome
		expect(named.sent.map((request) => `${request.method} ${request.url}`)).toEqual(["POST http://api.test/jobs/s1"])
		const unscoped = drive(answers([200, { status: "done" }]), {
			scope: { id: "s2" },
			spec: { idFrom: undefined } as never,
		})
		await unscoped.outcome
		expect(unscoped.sent[0]?.url).toBe("http://api.test/jobs/s2")
	})

	it("says when the poll path cannot be filled, without asking", async () => {
		const { outcome, sent } = drive(answers([200, {}]), { receipt: {}, spec: { poll: "GET /jobs/{id}/{part}" } })
		expect(await outcome).toMatchObject({
			polls: 0,
			state: "unfillable",
			unfillable: "no value for path parameter {id}",
		})
		expect(sent).toEqual([])
	})
})

describe("driveAsync, when the job does not finish", () => {
	it("tells a job that vanished after it was served", async () => {
		const { outcome } = drive(answers([404, {}], [200, { status: "running" }], [404, {}]))
		expect(await outcome).toMatchObject({ polls: 3, state: "vanished", succeeded: false, timedOut: false })
	})

	it("times out on a job that never ends", async () => {
		const { outcome } = drive(answers([409, {}]), { spec: { timeoutMs: 20 } })
		expect(await outcome).toMatchObject({ state: "timed-out", succeeded: false, terminal: null, timedOut: true })
	})

	it("polls as the principal continuing from the start, its credential resolved afresh for every poll", async () => {
		const { outcome, source } = drive(answers([200, { status: "running" }], [200, { status: "done" }]))
		const { exchanges } = await outcome
		expect(source.asked.length).toBeGreaterThanOrEqual(2)
		expect(source.asked.map((request) => request.actor)).toEqual(
			source.asked.map(() => ({ principal: "alpha", via: START })),
		)
		for (const poll of exchanges) expect([poll.principal, poll.schemes]).toEqual([START.principal, START.schemes])
	})
})
