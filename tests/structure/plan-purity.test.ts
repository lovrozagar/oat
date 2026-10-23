import { describe, expect, it } from "vitest"
import { referenceModel } from "../../src/report/console/__fixtures__/models.ts"
import { contextFor, modelOf, op } from "../../src/runtime/checks/__fixtures__/harness.ts"
import type { Check, OperationCheck } from "../../src/runtime/checks/core/check.ts"
import type { Actor, WriteContext } from "../../src/runtime/checks/core/context.ts"
import { entityChecks, operationChecks } from "../../src/runtime/checks/core/registry.ts"
import { planOn } from "../../src/runtime/checks/core/run.ts"
import { itemSchemaOf } from "../../src/runtime/checks/payloads/item-schema.ts"
import { notesContext, notesModel } from "../../src/runtime/checks/query/__fixtures__/notes.ts"
import { operationContextFor } from "../../src/runtime/checks/families/security/__fixtures__/operation-context.ts"
import { securedDoc } from "../../src/runtime/checks/families/security/__fixtures__/secured-api.ts"
import { CHECKS } from "../../src/runtime/checks/registry.ts"
import { mergeQueryCapabilities } from "../../src/spec/query/merge.ts"
import type { SpecModel } from "../../src/spec/graph/types.ts"
import type { JsonSchema } from "../../src/spec/types.ts"

/*
 * A check's plan has no side effects. The scheduler plans a check once to decide whether it
 * applies, and plans it again, with withheld query capabilities put back, to say which parameter a
 * check that stood down was missing. Both are safe only if planning sends nothing, records nothing
 * and changes nothing. Every registered check is planned twice on contexts rich enough to take its
 * plan past the first gate: nothing may be sent or recorded, the context must read the same after
 * as before, and the two plans must agree.
 */

const peer: Actor = { id: "beta", inviteAs: undefined, rank: 0, scope: { project_id: "p2" }, tenant: "t2" }
const actor: Actor = { id: "alpha", inviteAs: undefined, rank: 1, scope: { project_id: "p1" }, tenant: "t1" }

/** `value` as plain data: functions named, maps and sets as entries, a cycle as the path it closes. */
function snapshot(value: unknown, seen = new WeakMap<object, string>(), path = "$"): unknown {
	if (typeof value === "function") return "[function]"
	if (value === null || typeof value !== "object") return value
	const closed = seen.get(value)
	if (closed !== undefined) return `[cycle ${closed}]`
	seen.set(value, path)
	if (value instanceof Map) {
		return {
			map: [...value.entries()].map(([key, item], i) => [snapshot(key, seen), snapshot(item, seen, `${path}[${i}]`)]),
		}
	}
	if (value instanceof Set) return { set: [...value].map((item, i) => snapshot(item, seen, `${path}{${i}}`)) }
	if (Array.isArray(value)) return value.map((item, i) => snapshot(item, seen, `${path}[${i}]`))
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, snapshot((value as Record<string, unknown>)[key], seen, `${path}.${key}`)]),
	)
}

/** The context as data, without the model (compared once per context) and the schema validator's caches. */
function stateOf(ctx: WriteContext): unknown {
	const { model: _model, validator: _validator, client: _client, ...rest } = ctx
	return snapshot(rest)
}

/** Five rows that differ in every field `item` declares: strings, numbers, booleans and a null. */
function cohort(item: JsonSchema | null | undefined, identity: string): Record<string, unknown>[] {
	const properties = (item?.properties ?? {}) as Record<string, JsonSchema>
	return Array.from({ length: 5 }, (_, row) => {
		const record: Record<string, unknown> = {}
		for (const [name, schema] of Object.entries(properties)) {
			const type = Array.isArray(schema.type) ? schema.type.find((kind) => kind !== "null") : schema.type
			if (Array.isArray(schema.enum)) record[name] = schema.enum[row % schema.enum.length]
			else if (type === "integer" || type === "number") record[name] = (row * 7) % 5
			else if (type === "boolean") record[name] = row % 2 === 0
			else if (type === "array") record[name] = [`t${row % 2}`]
			else if (type === "string") record[name] = row === 3 ? null : `Row ${row % 3} x${row}`
		}
		record[identity] = `${identity}-${row}`
		return record
	})
}

interface Stage {
	name: string
	ctx: WriteContext
	model: SpecModel
	sent: unknown[]
}

/** The notes list, bare and with a cohort, two principals and a catalog of operators. */
function notesStages(): Stage[] {
	const bare = notesContext()
	const model = notesModel()
	const listOp = op(model, "note.list")
	const records = cohort(listOp.collection?.itemSchema, "id")
	const capabilities = mergeQueryCapabilities({
		entity: {
			aliases: { neq: "ne" },
			emptyIn: "reject",
			maxFilterConditions: 3,
			maxInValues: 4,
			operators: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin", "like", "ilike", "is"],
			searchCase: "insensitive",
			searchEmpty: "match-all",
			searchModes: ["plain"],
			searchable: ["name"],
			select: { nested: true, relations: [{ fields: ["id"], name: "owner" }], unknown: "reject" },
			selectable: ["id", "name"],
			sort: { defaultOrder: "name.asc", maxKeys: 2, nulls: ["first", "last"], stableTiebreak: "id" },
		},
		itemSchema: listOp.collection?.itemSchema ?? null,
		tag: listOp.query,
	})
	const rich = notesContext(
		() => undefined,
		{
			actors: [actor, peer],
			capabilities,
			peer,
			peerScope: peer.scope,
			records,
			scope: actor.scope,
			withheld: [{ axis: "sortable", row: { field: "rank" } }],
		},
		model,
	)
	return [
		{ ctx: bare.ctx, model: bare.ctx.model, name: "notes, empty", sent: bare.sent },
		{ ctx: rich.ctx, model, name: "notes, a cohort", sent: rich.sent },
		/* The same cohort on an entity with no list: a check that reads one cannot plan here. */
		{ ctx: { ...rich.ctx, listOp: undefined }, model, name: "notes, no list", sent: rich.sent },
	]
}

/** Every listable entity of the reference document, each with a cohort. */
async function referenceStages(): Promise<Stage[]> {
	const { model } = await referenceModel()
	const stages: Stage[] = []
	for (const entity of model.entities.values()) {
		/* An entity with no list (the webhook) is staged on its read, its cohort the records its read returns. */
		const listOp = entity.list === undefined ? undefined : op(model, entity.list)
		const anchor = entity.list ?? entity.read
		if (anchor === undefined) continue
		const ops = (id: string | undefined) => (id === undefined ? undefined : model.byOperationId.get(id))
		const identity = entity.identity ?? "id"
		const schema = itemSchemaOf({ listOp, model, readOp: ops(entity.read) })
		const staged = contextFor(model, anchor, {
			respond: () => undefined,
			fields: {
				entityName: entity.name,
				actors: [actor, peer],
				createOp: ops(entity.create),
				deleteOp: ops(entity.delete),
				identity,
				peer,
				peerScope: peer.scope,
				query: listOp?.query ?? null,
				readOp: ops(entity.read),
				records: cohort(schema, identity),
				updateOp: ops(entity.update),
			},
		})
		const ctx: WriteContext = { ...staged.ctx, listOp }
		stages.push({ ctx, model, name: `reference ${entity.name}`, sent: staged.sent })
	}
	return stages
}

/** Plans `check` twice on `stage`, asserting nothing changed; whether the plan applies. */
function planTwice(check: Check, stage: Stage): boolean {
	const before = stateOf(stage.ctx)
	const findings = stage.ctx.findings.findings.length
	/* Planned as the scheduler plans: a check that reads the listing needs a list to plan on. */
	const planned = planOn(check, stage.ctx)
	const first = snapshot(planned)
	const second = snapshot(planOn(check, stage.ctx))
	const where = `${check.id} on ${stage.name}`
	expect(second, `${where}: the second plan differs from the first`).toEqual(first)
	expect(stage.sent, `${where}: planning sent a request`).toEqual([])
	expect(stage.ctx.findings.findings.length, `${where}: planning recorded a finding`).toBe(findings)
	expect(stateOf(stage.ctx), `${where}: planning changed the context`).toEqual(before)
	return planned.ok
}

describe("a check's plan has no side effects", () => {
	it("plans every entity check twice without sending, recording or changing anything", async () => {
		const stages = [...notesStages(), ...(await referenceStages())]
		/* Both kinds of entity: listed, and with no list (a listing check is skipped there, unplanned). */
		expect(stages.map((stage) => stage.name)).toEqual(expect.arrayContaining(["notes, no list", "reference webhook"]))
		expect(stages.some((stage) => stage.ctx.listOp === undefined)).toBe(true)
		const checks = entityChecks(CHECKS)
		expect(checks.length).toBeGreaterThan(100)
		const applied = new Set<string>()
		for (const stage of stages) {
			const model = snapshot(stage.model)
			for (const check of checks) if (planTwice(check, stage)) applied.add(check.id)
			expect(snapshot(stage.model), `planning on ${stage.name} changed the model`).toEqual(model)
		}
		/* A plan that never applies here is only partly exercised: the stages stay rich enough that
		 * most plans run to the end. A floor, raised as stages grow, never lowered. */
		expect(applied.size).toBeGreaterThanOrEqual(89)
	})

	it("plans every operation check twice on every operation without sending or recording anything", () => {
		const model = modelOf(securedDoc())
		const before = snapshot(model)
		const checks: OperationCheck[] = operationChecks(CHECKS)
		expect(checks.length).toBeGreaterThan(5)
		for (const operation of model.operations) {
			for (const check of checks) {
				const { calls, ctx, findings, sent } = operationContextFor(model, operation.operationId, {
					peer,
					principals: [actor, peer],
				})
				const state = snapshot({ ...ctx, client: undefined, model: undefined })
				const first = snapshot(check.plan(ctx))
				const second = snapshot(check.plan(ctx))
				const where = `${check.id} on ${operation.operationId}`
				expect(second, `${where}: the second plan differs from the first`).toEqual(first)
				expect(sent, `${where}: planning sent a request`).toEqual([])
				/* Reading a principal's recipe is a lookup; minting or reading a credential is not. */
				expect({ dedicated: calls.dedicated, held: calls.held }, `${where}: planning asked for a credential`).toEqual({
					dedicated: [],
					held: [],
				})
				expect(findings.findings.length, `${where}: planning recorded a finding`).toBe(0)
				expect(
					snapshot({ ...ctx, client: undefined, model: undefined }),
					`${where}: planning changed the context`,
				).toEqual(state)
			}
		}
		expect(snapshot(model), "planning changed the model").toEqual(before)
	})
})
