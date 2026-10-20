import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { OpenApiDocument } from "../../spec/types.ts"
import { fakeClient, modelOf } from "../checks/__fixtures__/harness.ts"
import { notes, runOf } from "./__fixtures__/stage.ts"
import { ScenarioStopped, StepFailure } from "./failure.ts"
import { requestStep } from "./request.ts"

beforeEach(() => {
	vi.useFakeTimers({ now: 0 })
})

afterEach(() => {
	vi.useRealTimers()
})

/** A sleep that moves the clock on, and the waits it was asked for. */
function clock(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
	const waits: number[] = []
	return {
		sleep: async (ms) => {
			waits.push(ms)
			vi.setSystemTime(Date.now() + ms)
		},
		waits,
	}
}

const failure = async (pending: Promise<unknown>): Promise<StepFailure> => {
	const error = await pending.then(
		() => undefined,
		(thrown: unknown) => thrown,
	)
	if (!(error instanceof StepFailure)) throw new Error("the step did not fail")
	return error
}

describe("requestStep: credentials", () => {
	it("sends as the scenario's principal, another named one, one scheme of either, or anonymously", async () => {
		const run = runOf(notes())
		run.objects.set("doc", { text: "kept whole" })
		await requestStep(run, { body: "{doc}", operationId: "notes.create" }, 0)
		await requestStep(run, { operationId: "notes.list", principal: "beta" }, 1)
		await requestStep(run, { anonymous: true, operationId: "notes.list" }, 2)
		await requestStep(run, { operationId: "notes.list", scheme: "apiKey" }, 3)
		await requestStep(run, { operationId: "notes.list", principal: "beta", scheme: "apiKey" }, 4)
		expect(run.requests.map((request) => request.options.as)).toEqual([
			{ principal: "alpha" },
			{ principal: "beta" },
			{ anonymous: true },
			{ principal: "alpha", scheme: "apiKey" },
			{ principal: "beta", scheme: "apiKey" },
		])
		/* The client places the credential: a step's own headers never carry one. */
		expect(run.requests.map((request) => request.options.headers)).toEqual([{}, {}, {}, {}, {}])
		expect(run.requests[0]?.options.body).toEqual({ text: "kept whole" })
		expect(run.calls.get("notes.create")?.status).toBe(201)
	})

	it("sends a byte body as it is, under the media type the step names", async () => {
		const run = runOf(notes())
		const bytes = new Uint8Array([1, 2])
		await requestStep(run, { body: bytes, mediaType: "text/csv", operationId: "notes.create" }, 0)
		expect(run.requests[0]?.options).toMatchObject({ body: bytes, contentType: "text/csv" })
	})

	it("sends a raw method and path, with the step's query and headers", async () => {
		const run = runOf(notes())
		await requestStep(run, { headers: { "x-org": "{org}" }, method: "GET", path: "/notes", query: { q: "{org}" } }, 0)
		expect(run.requests[0]?.options).toMatchObject({
			as: { principal: "alpha" },
			headers: { "x-org": "o1" },
			query: { q: "o1" },
			redirect: "follow",
		})
		expect(run.calls.size).toBe(0)
	})
})

describe("requestStep: on another origin", () => {
	it("goes through that origin's client, which resolves the step's actor against its own document", async () => {
		const cdnDoc = {
			info: { title: "cdn", version: "1" },
			openapi: "3.1.0",
			paths: { "/files": { post: { operationId: "cdn.upload", responses: { "201": { description: "stored" } } } } },
		} as unknown as OpenApiDocument
		const cdn = fakeClient(() => ({ status: 201 }))
		const originClients = new Map([["cdn", { client: cdn.client, model: modelOf(cdnDoc) }]])
		const run = runOf(notes(), { originClients })
		await requestStep(run, { operationId: "cdn.upload", origin: "cdn", scheme: "upload" }, 0)
		expect(run.requests).toEqual([])
		expect(cdn.sent.map(({ method, options, path }) => ({ as: options.as, method, path }))).toEqual([
			{ as: { principal: "alpha", scheme: "upload" }, method: "POST", path: "/files" },
		])
	})
})

describe("requestStep: failures", () => {
	it("passes the statuses a step expects, and fails the rest", async () => {
		const run = runOf(notes())
		await requestStep(run, { expect: [404], operationId: "notes.get" }, 0)
		const refused = await failure(requestStep(run, { expect: [200], operationId: "notes.create" }, 1))
		expect(refused.message).toBe("POST /notes returned 201")
		expect(refused.blames).toEqual(["notes.create"])
		const raw = await failure(requestStep(run, { method: "GET", path: "/nowhere" }, 2))
		expect(raw.blames).toEqual([])
	})

	it("fails an assert it never saw, blaming what it would have proved", async () => {
		const run = runOf(notes())
		await requestStep(run, { body: { text: "first" }, operationId: "notes.create" }, 0)
		const unmet = await failure(
			requestStep(
				run,
				{
					assert: { equals: "second", from: "$.items[*].text", observes: ["notes.create", "notes.rename"] },
					operationId: "notes.list",
				},
				1,
			),
		)
		expect(unmet.message).toBe('GET /notes did not show equals "second" at $.items[*].text')
		expect(unmet.blames).toEqual(["notes.create", "notes.rename", "notes.list"])
		expect(unmet.evidence.map((exchange) => exchange.method)).toEqual(["POST", "GET"])
	})
})

describe("requestStep: polling", () => {
	it("re-sends with a growing wait until the assert holds", async () => {
		const held = notes()
		const { sleep, waits } = clock()
		const run = runOf(held, { sleep })
		let reads = 0
		held.answers["GET /notes"] = () => {
			reads += 1
			return { body: { total: reads }, status: 200 }
		}
		await requestStep(
			run,
			{ assert: { atLeast: 4, from: "$.total" }, operationId: "notes.list", poll: { within: "30s" } },
			0,
		)
		expect(waits).toEqual([500, 1000, 2000])
		expect(run.observations.get("notes.list")).toMatchObject({ path: "$.total", value: "4" })
	})

	it("fails once the window runs out, at the interval it asked for", async () => {
		const { sleep, waits } = clock()
		const run = runOf(notes(), { sleep })
		const late = await failure(
			requestStep(
				run,
				{ assert: { atLeast: 1, from: "$.total" }, operationId: "notes.list", poll: { everyMs: 6_000, within: "10s" } },
				0,
			),
		)
		expect(waits).toEqual([6_000, 6_000])
		expect(late.message).toBe('GET /notes did not show atLeast "1" at $.total')
	})

	it("stops polling once the run is told to stop, before or after a wait", async () => {
		const step = { assert: { atLeast: 9, from: "$.total" }, operationId: "notes.list", poll: { within: "1m" } }
		const before = runOf(notes(), { stopped: () => true })
		await expect(requestStep(before, step, 0)).rejects.toBeInstanceOf(ScenarioStopped)
		let asked = 0
		const after = runOf(notes(), {
			stopped: () => {
				asked += 1
				return asked > 1
			},
		})
		await expect(requestStep(after, step, 0)).rejects.toBeInstanceOf(ScenarioStopped)
		expect(after.requests).toHaveLength(1)
	})
})
