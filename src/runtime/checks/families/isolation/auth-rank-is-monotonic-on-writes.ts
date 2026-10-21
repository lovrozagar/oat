import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, asserted, type Outcome } from "../../../finding.ts"
import type { Actor, WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { scratchRecord, updateRequest } from "../../isolation/scratch.ts"
import { changedValue, pickWritableStringField, requestSchemaOf } from "../../payloads/body.ts"
import { createFresh } from "../../payloads/create.ts"
import { declared, itemParamFor } from "../../planning/subjects.ts"

type WriteVerdict = { allowed: boolean | null; exchange: Exchange }

const judgeWrite = (exchange: Exchange): WriteVerdict => ({
	allowed: exchange.status < 300 ? true : exchange.status === 401 || exchange.status === 403 ? false : null,
	exchange,
})

/**
 * The rank lattice holds for writes as it does for reads: a role that may create, update or
 * delete implies every higher role may too. A viewer that can edit what a member cannot is the
 * lattice inverted, and it is a write — the costly direction to get wrong.
 *
 * Each principal sharing the writer's tenant tries each write once, on a record made for the
 * try: creates go through the create operation, updates and deletes hit a scratch record each.
 */
export const rankIsMonotonicOnWrites = defineCheck<{ home: Actor[] }>({
	plan: (ctx) => {
		const primary = ctx.actors[0]
		if (primary === undefined || ctx.createOp === undefined) return cannot()
		const home = ctx.actors.filter((actor) => actor.tenant === primary.tenant)
		if (new Set(home.map((actor) => actor.rank)).size < 2) return cannot()
		return ready({ home })
	},
	dependsOn: ["list.read-after-write", "auth.rank-is-monotonic"],
	id: "auth.rank-is-monotonic-on-writes",
	mutates: true,
	needs: "two same-tenant principals at different ranks, and a create",
	subjects: (entity) => declared(entity.create, entity.update, entity.delete),
	async run(ctx, { home }): Promise<Outcome> {
		const writes = new Map<string, Map<string, WriteVerdict>>()
		const untested: string[] = []
		for (const actor of home) {
			const tried = await tryWrites(ctx, this.id, actor)
			if ("outcome" in tried) return tried.outcome
			if (tried.withheld !== undefined) untested.push(`${tried.withheld}, so its create is untested`)
			for (const [kind, verdict] of tried.verdicts) {
				writes.set(kind, (writes.get(kind) ?? new Map<string, WriteVerdict>()).set(actor.id, verdict))
			}
		}

		for (const [kind, verdicts] of writes) {
			const inverted = inversion(home, verdicts)
			if (inverted === null) continue
			const { hi, higher, lo, lower } = inverted
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: `a lower-ranked role can ${kind} where a higher-ranked role cannot`,
				detail:
					`${lower.id} (rank ${lower.rank}) was allowed to ${kind} ${ctx.entityName} ` +
					`(${lo.exchange.status}); ${higher.id} (rank ${higher.rank}) was refused ` +
					`(${hi.exchange.status}). Privilege must be monotonic on writes as on reads.`,
				evidence: [lo.exchange, hi.exchange],
			})
		}
		return untested.length === 0 ? ASSERTED : asserted(untested.join("; "))
	},
})

/* Each verdict, and why a create was never sent, when it was not. */
type Tried = { verdicts: Array<[string, WriteVerdict]>; withheld?: string } | { outcome: Outcome }

/** Each write `actor` tries once — a create, then an update and a delete on a scratch record each. */
async function tryWrites(ctx: WriteContext, check: string, actor: Actor): Promise<Tried> {
	const verdicts: Array<[string, WriteVerdict]> = []
	const createOp = ctx.createOp as OperationModel
	const schema = requestSchemaOf(ctx, createOp)
	const fresh = schema === null ? undefined : await createFresh(ctx, createOp, schema, actor.id)
	if (fresh !== undefined && "exchange" in fresh) verdicts.push(["create", judgeWrite(fresh.exchange)])
	const updateOp = ctx.updateOp
	if (updateOp !== undefined) {
		const updated = await tryUpdate(ctx, check, actor, updateOp)
		if ("outcome" in updated) return updated
		if (updated.verdict !== undefined) verdicts.push(["update", updated.verdict])
	}
	const deleteOp = ctx.deleteOp
	if (deleteOp !== undefined) {
		const made = await scratchRecord(ctx, check)
		if ("outcome" in made) return made
		const params = { ...ctx.scope, ...itemParamFor(ctx, made.scratch.id) }
		const deleted = await ctx.client.request("DELETE", fillPath(deleteOp.path, params), {
			as: { principal: actor.id },
			operationId: deleteOp.operationId,
		})
		verdicts.push(["delete", judgeWrite(deleted)])
	}
	return fresh !== undefined && "withheld" in fresh ? { verdicts, withheld: fresh.withheld } : { verdicts }
}

/** `actor` changes one field of a scratch record; no verdict when the record has no field to change. */
async function tryUpdate(
	ctx: WriteContext,
	check: string,
	actor: Actor,
	updateOp: OperationModel,
): Promise<{ verdict?: WriteVerdict } | { outcome: Outcome }> {
	const made = await scratchRecord(ctx, check)
	if ("outcome" in made) return made
	const field = pickWritableStringField(ctx, made.scratch.record)
	const value = field === null ? undefined : changedValue(ctx, field, made.scratch.record[field], updateOp)
	if (field === null || value === undefined) return {}
	const update = await updateRequest(ctx, updateOp, made.scratch.record, { [field]: value })
	const params = { ...ctx.scope, ...itemParamFor(ctx, made.scratch.id) }
	const updated = await ctx.client.request(update.method, fillPath(updateOp.path, params), {
		...update.options,
		as: { principal: actor.id },
		operationId: updateOp.operationId,
	})
	return { verdict: judgeWrite(updated) }
}

/** The first pair where the lower rank was allowed and the higher refused, in `home` order. */
function inversion(
	home: Actor[],
	verdicts: Map<string, WriteVerdict>,
): { lower: Actor; higher: Actor; lo: WriteVerdict; hi: WriteVerdict } | null {
	for (const lower of home) {
		for (const higher of home) {
			if (lower.rank >= higher.rank) continue
			const lo = verdicts.get(lower.id)
			const hi = verdicts.get(higher.id)
			if (lo?.allowed === true && hi?.allowed === false) return { hi, higher, lo, lower }
		}
	}
	return null
}
