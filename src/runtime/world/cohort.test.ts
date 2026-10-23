import { describe, expect, it } from "vitest"
import { type Responder, exchange, fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import type { CohortMember } from "../fixture.ts"
import { SeedError } from "../seed-error.ts"
import { NOTE, type NotesOptions, notes } from "./__fixtures__/documents.ts"
import { type CohortRun, failOrAdopt, postFresh, postMember, recordCreated, withGap } from "./cohort.ts"
import type { WorldOptions } from "./types.ts"

const refusal = (status: number, body: unknown) => exchange("POST", "/projects/p1/notes", { body, status })

function cohortRun(respond: Responder, document: NotesOptions = {}, options: Partial<WorldOptions> = {}) {
	const model = modelOf(notes(document))
	const fake = fakeClient(respond)
	const events: string[] = []
	const run: CohortRun = {
		acknowledged: false,
		unverified: undefined,
		createOp: op(model, "note.create"),
		existingIds: [],
		failedVariants: [],
		identity: "id",
		lastFail: undefined,
		ownIdentity: "id",
		path: "/projects/p1/notes",
		records: [],
		schema: NOTE,
		scope: { created: [], values: { projectId: "p1" } },
		seededMembers: [],
		seeding: {
			client: fake.client,
			model,
			options: {
				principal: "alpha",
				onCreate: (entity, id) => events.push(`created ${entity} ${id}`),
				onUnidentified: (entity, operationId) => events.push(`unidentified ${entity} ${operationId}`),
				roots: { projectId: "p1" },
				seed: 1,
				...options,
			},
		},
		uniqueGap: undefined,
	}
	return { events, run, sent: fake.sent }
}

const member = (body: Record<string, unknown>): CohortMember => ({ body, variant: "baseline" })

describe("recordCreated", () => {
	it("keeps the record the answer names and reports it made", async () => {
		const { run, events } = cohortRun(() => undefined)
		const record = await recordCreated(
			run,
			exchange("POST", run.path, { body: { id: "n1", name: "a" }, status: 201 }),
			{
				name: "a",
			},
		)
		expect(record).toEqual({ id: "n1", name: "a" })
		expect(events).toEqual(["created note n1"])
		expect(run.acknowledged).toBe(false)
	})

	it("marks an acknowledgement a read confirmed", async () => {
		const { run } = cohortRun(() => ({ body: { id: "c1", name: "a" }, status: 200 }), {}, { readable: () => true })
		expect(await recordCreated(run, exchange("POST", run.path, { status: 200 }), { id: "c1", name: "a" })).toEqual({
			id: "c1",
			name: "a",
		})
		expect(run.acknowledged).toBe(true)
	})

	it("reports a record it cannot identify, with or without a listener", async () => {
		const { run, events } = cohortRun(() => undefined)
		expect(await recordCreated(run, exchange("POST", run.path, { body: { ok: 1 }, status: 200 }), {})).toBeNull()
		expect(events).toEqual(["unidentified note note.create"])
		const quiet = cohortRun(() => undefined).run
		quiet.seeding.options = { principal: "alpha", roots: {}, seed: 1 }
		expect(await recordCreated(quiet, exchange("POST", quiet.path, { body: { ok: 1 }, status: 200 }), {})).toBeNull()
		expect(await recordCreated(quiet, exchange("POST", quiet.path, { body: { id: "n3" }, status: 200 }), {})).toEqual({
			id: "n3",
		})
	})
})

describe("posting members", () => {
	it("encodes the member, sends a form content type, and names an upload fixture", async () => {
		const form = {
			create: {
				requestBody: { content: { "application/x-www-form-urlencoded": { schema: NOTE } }, required: true },
			},
		}
		const { run, sent } = cohortRun(() => ({ body: { id: "n1" }, status: 201 }), form)
		await postMember(run, member({ id: "a", name: "x" }), { seed: 1 })
		expect(sent[0]?.options.contentType).toBe("application/x-www-form-urlencoded")
		const json = cohortRun(() => ({ body: { id: "n1" }, status: 201 }))
		await postMember(json.run, member({ id: "a", name: "x" }), {
			fixture: { filename: "a.pdf", path: "/tmp/a.pdf" },
			seed: 1,
		} as never)
		expect(json.sent[0]?.options).toMatchObject({ fixture: "a.pdf", operationId: "note.create" })
		expect(json.sent[0]?.options.contentType).toBeUndefined()
	})

	it("draws a client-chosen identity again after a 409, three times at most", async () => {
		const answers = [409, 409, 201]
		const fresh = cohortRun(() => ({ body: { id: "x" }, status: answers.shift() ?? 409 }))
		const posted = await postFresh(fresh.run, member({ id: "taken", name: "a" }), { seed: 1 })
		expect(posted.exchange.status).toBe(201)
		expect(fresh.sent.map((request) => (request.options.body as { id: string }).id)).toHaveLength(3)
		expect(posted.sent.body["id"]).not.toBe("taken")
		const taken = new Set<string>()
		const stubborn = cohortRun(() => ({ status: 409 }), {}, { nonce: "n0", taken: () => taken })
		const refused = await postFresh(stubborn.run, member({ id: "taken", name: "a" }), { seed: 1 })
		const ids = stubborn.sent.map((request) => (request.options.body as { id: string }).id)
		expect(refused.exchange.status).toBe(409)
		expect(ids).toHaveLength(3)
		expect([...taken].toSorted()).toEqual(ids.toSorted())
		expect(refused.exhausted).toMatch(/^every client-chosen "id" sent was refused with 409/)
	})

	it("takes a 409 as the answer when the body names no identity of its own", async () => {
		const noIdentity = cohortRun(() => ({ status: 409 }))
		await postFresh(noIdentity.run, member({ name: "a" }), { seed: 1 })
		noIdentity.run.ownIdentity = null
		await postFresh(noIdentity.run, member({ id: "a" }), { seed: 1 })
		expect(noIdentity.sent).toHaveLength(2)
	})
})

describe("withGap", () => {
	it("adds what the run learned, and only that", () => {
		const { run } = cohortRun(() => undefined)
		const cohort = { featureGate: null, members: [], records: [] }
		expect(withGap(run, cohort)).toEqual(cohort)
		const lost = { exchange: exchange("POST", "/", { status: 500 }), variant: "unicode" }
		Object.assign(run, { acknowledged: true, existingIds: ["n0"], failedVariants: [lost], uniqueGap: "gap" })
		expect(withGap(run, cohort)).toEqual({
			...cohort,
			acknowledged: true,
			existingIds: ["n0"],
			failedVariants: [lost],
			uniqueGap: "gap",
		})
	})
})

describe("failOrAdopt", () => {
	it("keeps the cohort it has when a later create fails", async () => {
		const { run } = cohortRun(() => undefined)
		run.records.push({ id: "n1" })
		expect(await failOrAdopt(run, member({}), refusal(500, null))).toMatchObject({ records: [{ id: "n1" }] })
	})

	it("stands down on a documented feature gate", async () => {
		const { run } = cohortRun(() => undefined, { create: { "x-feature-gate": "notes_pro" } })
		const gated = await failOrAdopt(
			run,
			member({}),
			refusal(403, { vars: { feature: "notes_pro", type: "feature_gate" } }),
		)
		expect(gated.featureGate).toMatchObject({
			detail: "x-feature-gate: notes_pro (feature: notes_pro)",
			key: "notes_pro",
		})
	})

	it("adopts a listed row after a unique conflict, or fails with the refusal", async () => {
		const unique = { create: { "x-unique": [["name"]] } }
		const adopted = cohortRun(() => ({ body: [{ id: "n4" }], status: 200 }), unique)
		expect(await failOrAdopt(adopted.run, member({}), refusal(409, {}))).toMatchObject({
			records: [{ id: "n4" }],
			uniqueAdopted: true,
		})
		const none = cohortRun(() => ({ body: [], status: 200 }), unique)
		await expect(failOrAdopt(none.run, member({}), refusal(409, { error: "taken" }))).rejects.toThrow(
			'seeding "baseline" returned 409: {"error":"taken"}',
		)
	})

	it("adopts a listed row under a plan limit, or fails with the refusal", async () => {
		const adopted = cohortRun(() => ({ body: [{ id: "n5" }], status: 200 }))
		expect(await failOrAdopt(adopted.run, member({}), refusal(402, null))).toMatchObject({
			adopted: true,
			records: [{ id: "n5" }],
		})
		const none = cohortRun(() => ({ body: [], status: 200 }))
		await expect(failOrAdopt(none.run, member({}), refusal(402, null))).rejects.toBeInstanceOf(SeedError)
		await expect(failOrAdopt(none.run, member({}), refusal(400, { error: "bad" }))).rejects.toThrow(
			'seeding "baseline" returned 400',
		)
	})
})
