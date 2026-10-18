import { describe, expect, it } from "vitest"
import type { Exchange } from "../../exchange.ts"
import { FencedError } from "../../fence.ts"
import { FixtureOverflow } from "../../fixture.ts"
import { SeedError } from "../../seed-error.ts"
import type { Record_ } from "../../world/records.ts"
import { contextOf, entityRunOf, notesApi, notesDoc, optionsFor, outage } from "../__fixtures__/api.ts"
import type { RunOptions } from "../types.ts"
import { seedFailed } from "./seed-failure.ts"

/*
 * A seed that threw, reported as what it was: the network gone, a request fenced, fixtures that
 * cannot be built, or a create that failed — a defect when it crashed, and support when a
 * targeted run never asked about it. Where records exist, the entity is still read against them.
 */

async function failing(rows: Record_[], error: unknown, extra: Partial<RunOptions> = {}) {
	const ctx = await contextOf(optionsFor(notesApi(notesDoc(), rows), extra))
	const run = entityRunOf(ctx)
	const createOp = ctx.model.byOperationId.get("notes.create")
	if (createOp === undefined) throw new Error("no create")
	return { ctx, world: await seedFailed(run, createOp, error) }
}

const crashed = { method: "POST", seq: 1, status: 500, url: "http://api.test/notes" } as Exchange
const ROWS = (): Record_[] => [{ id: "n0", title: "old" }]

describe("seedFailed", () => {
	it("notes the network going away, and tests nothing more of the entity", async () => {
		const { ctx, world } = await failing(ROWS(), outage("dns"))
		expect(world).toBeNull()
		expect(ctx.network.outcome?.kind).toBe("dns")
	})

	it("blocks an entity whose seeding was fenced", async () => {
		const fenced = new FencedError({ method: "POST", phase: "seed", reason: "writes off", url: "u" })
		const { ctx, world } = await failing(ROWS(), fenced)
		expect(world).toBeNull()
		expect(ctx.findings.findings[0]).toMatchObject({
			summary: 'seeding "note" was fenced: writes off',
			verdict: "BLOCKED",
		})
	})

	it("reports fixtures that cannot be built, then reads what exists or blocks", async () => {
		const overflow = new FixtureOverflow("notes.create", "/title", "too long")
		const withRows = await failing(ROWS(), overflow)
		expect(withRows.world).toMatchObject({ degraded: true, records: [{ id: "n0" }] })
		expect(withRows.ctx.findings.findings.map((finding) => finding.verdict)).toEqual(["COVERAGE_GAP"])
		const empty = await failing([], overflow)
		expect(empty.world).toBeNull()
		expect(empty.ctx.findings.findings.map((finding) => finding.summary)).toEqual([
			overflow.message,
			'could not seed "note"',
		])
	})
})

const createCrashed = () =>
	new SeedError("notes.create", "returned 500", { exchange: crashed, operationId: "notes.create", status: 500 })

describe("seedFailed on a create that failed", () => {
	it("reports a create that crashed as the defect, and reads what exists", async () => {
		const error = createCrashed()
		const { ctx, world } = await failing(ROWS(), error)
		expect(world).toMatchObject({ degraded: true })
		expect(ctx.findings.findings.map((finding) => [finding.check, finding.verdict])).toEqual([
			["create.does-not-error", "BACKEND_BUG"],
			["world.seed", "COVERAGE_GAP"],
		])
		expect(ctx.findings.findings[0]?.evidence).toEqual([crashed])
	})

	it("blocks, without a defect of its own, on a support create a targeted run did not ask about", async () => {
		const error = createCrashed()
		const { ctx, world } = await failing([], error, { ops: ["notes.get"] })
		expect(world).toBeNull()
		expect(ctx.findings.findings).toEqual([
			expect.objectContaining({
				check: "world.seed",
				detail: expect.stringContaining("support operation notes.create failing"),
				verdict: "BLOCKED",
			}),
		])
	})

	it("blocks on a create that was refused, naming the culprit", async () => {
		const error = new SeedError("org_id", "no org", { status: 400 })
		const { ctx, world } = await failing([], error)
		expect(world).toBeNull()
		expect(ctx.findings.findings[0]).toMatchObject({
			detail: expect.stringContaining("org_id: no org"),
			verdict: "BLOCKED",
		})
	})

	it("takes the last server error the run saw as evidence for a failure that brought none", async () => {
		const notes = notesApi()
		const ctx = await contextOf(
			optionsFor((method, path, request) => (path === "/boom" ? { status: 502 } : notes(method, path, request))),
		)
		await ctx.client.get("/boom")
		const createOp = ctx.model.byOperationId.get("notes.create")
		if (createOp === undefined) throw new Error("no create")
		expect(await seedFailed(entityRunOf(ctx), createOp, "plain failure")).toBeNull()
		expect(ctx.findings.findings[0]).toMatchObject({ detail: expect.stringContaining("unknown: plain failure") })
		expect(ctx.findings.findings[0]?.evidence.map((exchange) => exchange.status)).toEqual([502])
	})

	it("keeps a failure with no server error behind it free of evidence", async () => {
		const { ctx } = await failing([], new Error("odd"))
		expect(ctx.findings.findings[0]?.evidence).toEqual([])
	})
})
