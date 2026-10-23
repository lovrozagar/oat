import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../../spec/graph/types.ts"
import { contextOf, entityRunOf, notesApi, notesDoc, optionsFor } from "../__fixtures__/api.ts"
import { existingOrBlocked, readExisting, worldOptions } from "./fallback.ts"

/* Read-only coverage against what already exists, when oat cannot seed; blocked when nothing does. */

const scoped = notesDoc({
	"/orgs/{org_id}/notes": {
		get: {
			operationId: "orgnotes.list",
			parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
			responses: { "200": { description: "ok" } },
		},
	},
})

describe("readExisting", () => {
	it("lists what exists, carrying every root", async () => {
		const ctx = await contextOf(optionsFor(notesApi(notesDoc(), [{ id: "n1", title: "a" }])))
		expect(await readExisting(entityRunOf(ctx), { org_id: "o1" })).toEqual({
			records: [{ id: "n1", title: "a" }],
			scope: { org_id: "o1" },
		})
	})

	it("reads nothing when the list path needs an id no root holds", async () => {
		const options = optionsFor(notesApi(scoped))
		const ctx = await contextOf(options)
		const run = { ...entityRunOf(ctx), listOp: ctx.model.byOperationId.get("orgnotes.list") as never }
		expect(await readExisting(run, {})).toEqual({ records: [], scope: {} })
		expect(options.seen.some((request) => request.path.startsWith("/orgs"))).toBe(false)
	})
})

describe("existingOrBlocked", () => {
	it("is a degraded world over what exists", async () => {
		const ctx = await contextOf(optionsFor(notesApi(notesDoc(), [{ id: "n1", title: "a" }])))
		const world = await existingOrBlocked(entityRunOf(ctx), { check: "world.seed", detail: "d", summary: "s" })
		expect(world).toMatchObject({ degraded: true, records: [{ id: "n1" }], uniqueAdopted: false })
		expect(ctx.findings.findings).toEqual([])
	})

	it("blocks the entity, with the evidence, when nothing exists", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		const blocked = { check: "world.seed", detail: "why", evidence: [], summary: "could not" }
		expect(await existingOrBlocked(entityRunOf(ctx), blocked)).toBeNull()
		expect(ctx.findings.findings).toEqual([
			expect.objectContaining({ check: "world.seed", entity: "note", summary: "could not", verdict: "BLOCKED" }),
		])
	})
})

describe("worldOptions", () => {
	it("builds as the first principal, under the run's seed and nonce", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		const options = worldOptions(entityRunOf(ctx))
		expect(options).toMatchObject({ nonce: "n0nce", principal: "alpha", roots: {}, seed: 1 })
		expect(options).not.toHaveProperty("authHeaders")
	})

	it("withholds a create only a higher rank of the first principal's tenant may send", async () => {
		const higher = { alpha: { rank: 1, tenant: "t1" }, root: { rank: 2, tenant: "t1" } }
		const ctx = await contextOf(optionsFor(notesApi(), { principals: higher }))
		const required = {
			...(ctx.model.byOperationId.get("notes.create") as OperationModel),
			privilegedRequired: ["plan"],
		}
		expect(worldOptions(entityRunOf(ctx)).withheld?.(required)).toMatch(
			/^notes\.create requires plan, .* only root \(rank 2\)/,
		)
		const top = worldOptions(entityRunOf(await contextOf(optionsFor(notesApi()))))
		expect(top.withheld?.(required)).toBeUndefined()
	})

	it("hands seeding and ancestors the run's identities per entity, which a later run of the entity keeps", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		const run = entityRunOf(ctx)
		const { taken } = worldOptions(run)
		expect(taken?.("note")).toBe(run.taken)
		taken?.("table").add("7")
		run.taken.add("n9")
		expect(ctx.state.takenByEntity.get("table")).toEqual(new Set(["7"]))
		expect(entityRunOf(ctx).taken).toEqual(new Set(["n9"]))
	})
})

describe("readExisting with no list", () => {
	it("reads nothing, keeping the roots as the scope", async () => {
		const options = optionsFor(notesApi(notesDoc(), [{ id: "n1" }]))
		const ctx = await contextOf(options)
		const before = options.seen.length
		expect(await readExisting({ ...entityRunOf(ctx), listOp: undefined }, { org_id: "o1" })).toEqual({
			records: [],
			scope: { org_id: "o1" },
		})
		expect(options.seen.length).toBe(before)
	})
})
