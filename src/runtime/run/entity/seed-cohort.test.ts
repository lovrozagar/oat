import { describe, expect, it } from "vitest"
import type { JsonSchema, OpenApiDocument } from "../../../spec/types.ts"
import type { Answer, Responder } from "../../checks/__fixtures__/harness.ts"
import type { Record_ } from "../../world/records.ts"
import { contextOf, entityRunOf, notesApi, notesDoc, optionsFor, overriding } from "../__fixtures__/api.ts"
import type { RunOptions } from "../types.ts"
import { seedCreated } from "./seed-cohort.ts"

/*
 * A cohort seeded through the entity's create: oat's own records; a variant the backend refused,
 * reported; a row adopted after a plan limit or a unique conflict; a documented feature gate read
 * as coverage, not a defect.
 */

type Json = Record<string, unknown>

/** The notes document with its create edited: its tags, and the note schema it sends. */
function docWith(edit: (create: Json, note: JsonSchema) => void): OpenApiDocument {
	const doc = structuredClone(notesDoc()) as unknown as { paths: Record<string, Record<string, Json>> }
	const create = doc.paths["/notes"]?.post as Json
	const body = create.requestBody as { content: Record<string, { schema: JsonSchema }> }
	edit(create, body.content["application/json"]?.schema as JsonSchema)
	return doc as unknown as OpenApiDocument
}

/** Answers each create in turn with `answers`, then as the notes API would. */
function createsAnswered(...answers: Answer[]): Responder {
	let creates = 0
	return (method, path) => {
		if (method !== "POST" || path !== "/notes") return undefined
		creates += 1
		return answers[creates - 1]
	}
}

/** Seeds the notes entity against `backend`, with `override` answering first. */
async function seeded(backend: Responder, override: Responder, extra: Partial<RunOptions> = {}) {
	const ctx = await contextOf(optionsFor(overriding(backend, override), extra))
	const run = entityRunOf(ctx)
	const createOp = ctx.model.byOperationId.get("notes.create")
	if (createOp === undefined) throw new Error("no create")
	return { ctx, run, world: await seedCreated(run, createOp) }
}

const none: Responder = () => undefined

describe("seedCreated", () => {
	it("seeds oat's own records, and marks every identity the collection holds as taken", async () => {
		const { world, run } = await seeded(notesApi(notesDoc(), [{ id: "n0", title: "old" }]), none)
		expect(world).toMatchObject({ createAcknowledged: false, degraded: false, uniqueAdopted: false })
		expect(world?.records.length).toBeGreaterThan(0)
		expect(run.taken.has("n0")).toBe(true)
		expect(run.taken.size).toBe((world?.records.length ?? 0) + 1)
	})

	it("reports a variant the create crashed on, and one it refused, and seeds without them", async () => {
		const { world, run, ctx } = await seeded(
			notesApi(notesDoc(), []),
			createsAnswered(undefined as never, { status: 500 }, { body: { e: 1 }, status: 422 }),
		)
		expect(world?.records.length).toBeGreaterThan(0)
		expect(run.lostVariants).toHaveLength(2)
		const [crashed, refused] = ctx.findings.findings
		expect(crashed).toMatchObject({ check: "create.does-not-error", verdict: "BACKEND_BUG" })
		expect(refused).toMatchObject({ check: "world.seed", summary: expect.stringContaining("was refused with 422") })
	})

	it("says when unique values could not be made to differ", async () => {
		const doc = docWith((create, note) => {
			create["x-unique"] = ["kind"]
			note.properties = { ...(note.properties as Json), kind: { enum: ["only"], type: "string" } }
			note.required = ["title", "kind"]
		})
		const { ctx } = await seeded(notesApi(doc, []), (method, path, request) =>
			method === "POST" && path === "/notes"
				? { body: { ...(request.body as Json), id: "k1" }, status: 201 }
				: undefined,
		)
		expect(ctx.findings.findings[0]).toMatchObject({ check: "world.seed", verdict: "COVERAGE_GAP" })
	})
})

describe("seedCreated adopting", () => {
	it("adopts a same-tenant row after a plan limit, standing the write checks down", async () => {
		const { world, ctx } = await seeded(
			notesApi(notesDoc(), [{ id: "n0", title: "old" }]),
			createsAnswered({ body: { error: "plan_limit" }, status: 402 }),
		)
		expect(world).toMatchObject({ degraded: true, records: [{ id: "n0" }], uniqueAdopted: false })
		expect(ctx.findings.findings[0]?.summary).toBe(
			'seeding "note" hit a plan limit; using an existing same-tenant record',
		)
	})

	it("adopts a same-tenant row after a unique conflict, keeping the unique checks", async () => {
		const doc = docWith((create) => {
			create["x-unique"] = ["title"]
		})
		const { world, ctx } = await seeded(notesApi(doc, [{ id: "n0", title: "old" }]), createsAnswered({ status: 409 }))
		expect(world).toMatchObject({ degraded: true, uniqueAdopted: true })
		expect(ctx.findings.findings[0]?.summary).toBe('seeding "note" could not insert because of x-unique')
	})

	it("reads a documented feature gate as coverage, falling back to what exists", async () => {
		const doc = docWith((create) => {
			create["x-feature-gate"] = "pro"
		})
		const gate = { body: { vars: { key: "pro", type: "feature_gate" } }, status: 403 }
		const withRows = await seeded(notesApi(doc, [{ id: "n0", title: "old" }]), createsAnswered(gate))
		expect(withRows.world).toMatchObject({ degraded: true, records: [{ id: "n0" }] })
		expect(withRows.ctx.findings.findings[0]?.summary).toMatch(/^seeding "note" is gated by /)
		const empty = await seeded(notesApi(doc, []), createsAnswered(gate))
		expect(empty.world).toBeNull()
		expect(empty.ctx.findings.findings.at(-1)).toMatchObject({ summary: 'could not test "note"', verdict: "BLOCKED" })
	})
})

describe("seedCreated identities", () => {
	it("trusts a create that only acknowledged, once a read shows what it sent", async () => {
		const doc = docWith((_, note) => {
			note.properties = { ...(note.properties as Json), id: { type: "string" } }
			note.required = ["id", "title"]
		})
		const rows: Record_[] = []
		const { world } = await seeded(notesApi(doc, rows), (method, path, request) => {
			if (method !== "POST" || path !== "/notes") return undefined
			rows.push(request.body as Record_)
			return { body: { status: "accepted" }, status: 202 }
		})
		expect(world?.createAcknowledged).toBe(true)
	})

	it("reports a seed that failed as what it is", async () => {
		const { world, ctx } = await seeded(notesApi(notesDoc(), []), (method) =>
			method === "POST" ? { status: 500 } : undefined,
		)
		expect(world).toBeNull()
		expect(ctx.findings.findings.map((finding) => finding.check)).toEqual(["create.does-not-error", "world.seed"])
	})

	it("seeds no more than the configured cohort", async () => {
		const { world } = await seeded(notesApi(notesDoc(), []), none, { cohortSize: 1 })
		expect(world?.records).toHaveLength(1)
	})

	it("takes a numeric identity as taken too", async () => {
		const doc = docWith((_, note) => {
			note.properties = { ...(note.properties as Json), id: { readOnly: true, type: "integer" } }
		})
		let next = 0
		const { run } = await seeded(notesApi(doc, []), (method, path, request) => {
			if (method !== "POST" || path !== "/notes") return undefined
			next += 1
			return { body: { ...(request.body as Json), id: next }, status: 201 }
		})
		expect(run.taken.has("1")).toBe(true)
	})

	it("takes no identity for an entity nothing identifies", async () => {
		/* No item route and no id-like field in the schema: the answers' ids track the records, but the
		 * entity names no identity a later create could collide on. */
		const doc = docWith((_, note) => {
			note.properties = { title: { type: "string" } }
		}) as unknown as { paths: Record<string, unknown> }
		delete doc.paths["/notes/{note_id}"]
		const { world, run } = await seeded(notesApi(doc as unknown as OpenApiDocument, []), none)
		expect(run.entity.identity).toBeNull()
		expect(world?.records.length).toBeGreaterThan(0)
		expect(run.taken.size).toBe(0)
	})
})
