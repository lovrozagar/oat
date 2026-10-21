import { describe, expect, it } from "vitest"
import type { Client } from "../client/client.ts"
import { buildModel } from "../spec/graph/build.ts"
import { dereference } from "../spec/load/dereference.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { createTracker } from "./create-tracker.ts"
import type { Exchange } from "./exchange.ts"
import { FencedError } from "./fence.ts"
import { Ledger } from "./teardown/ledger.ts"

/*
 * A POST that is not its entity's create can still make a record: an untagged document files
 * `job.start` under job as an action, and its answer names the job it started. The tracker ledgers
 * such a record, marked inferred, only when the answer names a new `<entity>_id` and a read of that
 * id answers 2xx as the principal that sent it.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const OBJECT = { type: "object" }
const ok = { "202": { ...json(OBJECT), description: "accepted" } }
const PROJECT = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const JOB = { in: "path", name: "job_id", required: true, schema: { type: "string" } }
const on = (name: string, action: string) => ({ "x-entity": { action, name } })
const action = (operationId: string, name = "job", more: object = {}) => ({
	operationId,
	parameters: [PROJECT],
	responses: ok,
	...on(name, "action"),
	...more,
})

const DOCUMENT = {
	info: { title: "inferred", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/projects/{project_id}/jobs": {
			post: { operationId: "job.create", parameters: [PROJECT], responses: ok, ...on("job", "create") },
		},
		"/projects/{project_id}/jobs/{job_id}": {
			delete: { operationId: "job.delete", parameters: [PROJECT, JOB], responses: ok, ...on("job", "delete") },
			get: { operationId: "job.get", parameters: [PROJECT, JOB], responses: ok, ...on("job", "read") },
		},
		"/projects/{project_id}/jobs/start": { post: action("job.start") },
		"/projects/{project_id}/jobs/notify": { post: action("job.notify") },
		"/projects/{project_id}/jobs/{job_id}/retry": {
			post: { ...action("job.retry"), parameters: [PROJECT, JOB] },
		},
		"/projects/{project_id}/jobs/kick": {
			post: action("job.kick", "job", { "x-effects": [{ count: 1, entity: "job", op: "create" }] }),
		},
		"/projects/{project_id}/jobs/queue": {
			post: action("job.queue", "job", {
				"x-async": { idFrom: "$.job_id", poll: "GET /projects/{project_id}/jobs/{job_id}", until: "status.eq.done" },
			}),
		},
		"/projects/{project_id}/batches/start": { post: action("batch.start", "batch") },
		"/projects/{project_id}/batches": {
			post: { operationId: "batch.create", parameters: [PROJECT], responses: ok, ...on("batch", "create") },
		},
		"/ping": { post: { operationId: "misc.ping", responses: ok } },
		"/invites/{token}/accept": {
			post: {
				operationId: "invite.accept",
				parameters: [{ in: "path", name: "token", required: true, schema: { type: "string" } }],
				responses: ok,
				...on("job", "action"),
			},
		},
	},
} as unknown as OpenApiDocument

const BASE = "http://api.test"

/** What a POST answered, with what it sent, and where it sits in the transcript. */
interface Reply {
	body: unknown
	seq: number
	sent?: unknown
}

/** A 2xx POST alpha sent to `path` as `operationId`. */
function post(operationId: string, path: string, { body, seq, sent }: Reply): Exchange {
	return {
		at: seq,
		method: "POST",
		operationId,
		principal: "alpha",
		requestBody: sent,
		responseBody: body,
		seq,
		status: 202,
		url: `${BASE}${path}`,
	} as Exchange
}

/** What a read of a path answers: a status, or an error the client throws. */
type ReadAnswer = number | Error

function setup(reads: Record<string, ReadAnswer> = {}, transcript: Exchange[] = [], readable = true) {
	const model = buildModel(dereference(DOCUMENT).doc)
	const ledger = new Ledger()
	const recorded: string[] = []
	const sent: string[] = []
	const client = {
		get: async (path: string, options: { as: { principal: string } }) => {
			sent.push(`GET ${path} as ${options.as.principal}`)
			const answer = reads[path] ?? 404
			if (answer instanceof Error) throw answer
			return { status: answer }
		},
		hydrate: async (exchange: Exchange) => exchange,
		relativePath: (url: string) => new URL(url).pathname,
		request: async (method: string, path: string) => {
			sent.push(`${method} ${path}`)
			return { status: 204 }
		},
		transcript,
		view: () => client,
	} as unknown as Client
	const tracker = createTracker({
		client,
		ledger,
		model,
		onRecorded: (entity, id) => recorded.push(`${entity} ${id}`),
		owners: new Map([["alpha", { owner: { id: "alpha" }, roots: { project_id: "a" } }]]),
		readable: () => readable,
	})
	return { client, ledger, model, observe: tracker.observe, recorded, sent }
}

const STARTED = "/projects/a/jobs/job_000071"

describe("an inferred create", () => {
	it("ledgers the job an untagged job.start answers, marked inferred, and tears it down", async () => {
		const unrelated = post("job.notify", "/projects/a/jobs/notify?x=1", {
			body: { notification_id: "n_1" },
			seq: 3,
			sent: { m: "hi" },
		})
		const { client, ledger, model, observe, recorded, sent } = setup({ [STARTED]: 200 }, [unrelated])
		await observe(
			post("job.start", "/projects/a/jobs/start", { body: { accepted: true, job_id: "job_000071" }, seq: 7 }),
		)
		expect(sent).toEqual([`GET ${STARTED} as alpha`])
		expect(ledger.entries()).toEqual([
			{ entity: "job", id: "job_000071", inferred: true, owner: { id: "alpha" }, scope: { project_id: "a" } },
		])
		expect(recorded).toEqual(["job job_000071"])
		const report = await ledger.unwind(model, client, { fallbacks: () => [], options: { verify: false } })
		expect(sent.at(-1)).toBe(`DELETE ${STARTED}`)
		expect(report.removed).toBe(1)
		expect(report.records).toEqual([
			{ entity: "job", id: "job_000071", inferred: true, principal: "alpha", removed: true },
		])
	})
})

describe("an inferred create: what it never ledgers", () => {
	it("does not ledger job.notify, invite.accept, or a POST that names, affects or awaits its entity", async () => {
		const { ledger, observe, sent } = setup({ [STARTED]: 200 })
		await observe(post("job.notify", "/projects/a/jobs/notify", { body: { notification_id: "n_1" }, seq: 1 }))
		await observe(post("invite.accept", "/invites/tok/accept", { body: { accepted: true }, seq: 2 }))
		await observe(post("job.retry", `${STARTED}/retry`, { body: { job_id: "job_000071" }, seq: 3 }))
		await observe(post("job.kick", "/projects/a/jobs/kick", { body: { job_id: "job_000071" }, seq: 4 }))
		await observe(post("job.queue", "/projects/a/jobs/queue", { body: { job_id: "job_000071" }, seq: 5 }))
		await observe(post("batch.start", "/projects/a/batches/start", { body: { batch_id: "b_1" }, seq: 6 }))
		await observe(post("misc.ping", "/ping", { body: { job_id: "job_000071" }, seq: 7 }))
		await observe(post("job.start", "/projects/a/jobs/start", { body: { job_id: "" }, seq: 8 }))
		await observe(post("job.start", "/projects/a/jobs/start", { body: { job_id: 71 }, seq: 9 }))
		await observe(post("job.start", "/projects/a/jobs/start", { body: ["job_000071"], seq: 10 }))
		await observe(post("job.start", "/elsewhere", { body: { job_id: "job_000071" }, seq: 11 }))
		await observe({
			...post("job.start", "/projects/a/jobs/start", { body: { job_id: "job_000071" }, seq: 12 }),
			method: "PUT",
		})
		await observe({
			...post("job.start", "/projects/a/jobs/start", { body: { job_id: "job_000071" }, seq: 13 }),
			operationId: "x.y",
		})
		expect(sent).toEqual([])
		expect(ledger.entries()).toEqual([])
	})
})

describe("an inferred create: the evidence it needs", () => {
	it("does not ledger an id the read does not answer 2xx, or cannot send", async () => {
		const fenced = new FencedError({ method: "GET", phase: "assertion", reason: "no reads", url: STARTED })
		for (const answer of [404, fenced]) {
			const { ledger, observe, sent } = setup({ [STARTED]: answer })
			await observe(post("job.start", "/projects/a/jobs/start", { body: { job_id: "job_000071" }, seq: 1 }))
			expect(sent).toEqual([`GET ${STARTED} as alpha`])
			expect(ledger.entries()).toEqual([])
		}
		const unreadable = setup({ [STARTED]: 200 }, [], false)
		await unreadable.observe(post("job.start", "/projects/a/jobs/start", { body: { job_id: "job_000071" }, seq: 1 }))
		expect(unreadable.sent).toEqual([])
		expect(unreadable.ledger.entries()).toEqual([])
		const broken = setup({ [STARTED]: new Error("the transport broke") })
		await expect(
			broken.observe(post("job.start", "/projects/a/jobs/start", { body: { job_id: "job_000071" }, seq: 1 })),
		).rejects.toThrow("the transport broke")
	})

	it("does not ledger an id the run already saw, in an earlier exchange or this request, or already ledgered", async () => {
		const answer = { job_id: "job_000071" }
		const earlier = [
			post("job.notify", "/projects/a/jobs/notify", { body: { note: "job_000071" }, seq: 1 }),
			post("job.notify", "/projects/a/jobs/notify", { body: {}, seq: 1, sent: { about: ["job_000071"] } }),
			post("job.notify", "/projects/a/jobs/job_000071/notify?x=1", { body: {}, seq: 1 }),
		]
		for (const seen of earlier) {
			const { ledger, observe, sent } = setup({ [STARTED]: 200 }, [seen])
			await observe(post("job.start", "/projects/a/jobs/start", { body: answer, seq: 2 }))
			expect(sent).toEqual([])
			expect(ledger.entries()).toEqual([])
		}
		const self = setup({ [STARTED]: 200 })
		await self.observe(
			post("job.start", "/projects/a/jobs/start", { body: answer, seq: 2, sent: { job_id: "job_000071" } }),
		)
		expect(self.ledger.entries()).toEqual([])
		const later = setup({ [STARTED]: 200 }, [post("job.notify", "/projects/a/jobs/notify", { body: answer, seq: 9 })])
		await later.observe(post("job.start", "/projects/a/jobs/start", { body: answer, seq: 2 }))
		await later.observe(post("job.start", "/projects/a/jobs/start", { body: answer, seq: 3 }))
		expect(later.sent).toEqual([`GET ${STARTED} as alpha`])
		expect(later.ledger.entries()).toHaveLength(1)
	})
})
