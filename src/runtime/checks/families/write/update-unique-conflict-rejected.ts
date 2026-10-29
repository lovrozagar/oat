import type { Client } from "../../../../client/client.ts"
import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import {
	bodyPropertyNames,
	collisionUpdatePatch,
	idempotencyHeaderRequired,
	leakedCollisions,
	probeableUniqueSets,
	uniqueProbeHeaders,
} from "../../../unique.ts"
import type { Exchange } from "../../../exchange.ts"
import { idOf, type Record_ } from "../../../world/records.ts"
import { isPlanLimitResponse } from "../../../world/plan-limit.ts"
import type { Listed, WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { scratchRecord, updateRequest } from "../../isolation/scratch.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"
import { pageSize, q } from "../../query/capabilities.ts"
import { type Listing, listAll } from "../../sets/compare.ts"
import { liveRecord } from "./records.ts"

export const uniqueConflictUpdate: Check<{
	first: Record_
	sets: string[][]
	updateOp: OperationModel
}> = defineCheck<{
	first: Record_
	sets: string[][]
	updateOp: OperationModel
}>({
	plan: (ctx) => {
		const updateOp = ctx.uniqueUpdateOp
		const [first] = ctx.records
		if (updateOp === undefined || (ctx.uniqueSets?.length ?? 0) === 0 || first === undefined) return cannot()
		if (ctx.createOp === undefined) return cannot()
		const sets = probeableUniqueSets(updateOp, ctx.model, { phase: "update", sets: ctx.uniqueSets })
		return sets.length === 0 ? cannot() : ready({ first, sets, updateOp })
	},
	/* Reads whole sets across pages, so a walk that skips or repeats records corrupts them. */
	dependsOn: ["pagination.page-walk-covers-set"],
	id: "update.unique-conflict-rejected",
	lists: true,
	mutates: true,
	needs: "x-unique, an update operation with a probeable set, a create, and a known row",
	subjects: subjectsOf.update,
	async run(ctx, { first, sets, updateOp }): Promise<Outcome> {
		const bodyCols = bodyPropertyNames(updateOp, ctx.model)
		const required = idempotencyHeaderRequired(updateOp, ctx.model)
		const listLimit = pageSize(ctx)
		const source = (await liveRecord(ctx, idOf(first, ctx.identity))) ?? first
		const probe = { bodyCols, check: this.id, listLimit, required, source, updateOp }
		for (const [index, set] of sets.entries()) {
			const stopped = await probeUpdateSet(ctx, probe, set, index)
			if (stopped !== undefined) return stopped
		}
		return ASSERTED
	},
})

/** What every unique probe on one update shares: the row whose values are collided with. */
interface UpdateProbe {
	check: string
	updateOp: OperationModel
	bodyCols: ReadonlySet<string>
	required: boolean
	listLimit: number
	source: Record_
}

/** One set's probe; an outcome only when no record could be made for it, which ends the check. */
async function probeUpdateSet(
	ctx: Listed<Client>,
	probe: UpdateProbe,
	set: string[],
	index: number,
): Promise<Outcome | undefined> {
	const { source, updateOp } = probe
	/* The record that is made to collide is one made for the purpose: a cohort record
	 * written onto another's unique values is no longer the record every other check
	 * planned against, and a backend that accepts the write leaves the two indistinct. */
	const made = await scratchRecord(ctx, probe.check)
	if ("outcome" in made) return made.outcome
	const target = made.scratch.record
	if (!set.some((col) => JSON.stringify(target[col]) !== JSON.stringify(source[col]))) return undefined
	/* Read once the record exists, so its own create is not mistaken for growth. A growth
	 * is only visible when both reads cover the whole collection. */
	const before = await listAll(ctx, q(ctx, { limit: probe.listLimit }))
	const patch = collisionUpdatePatch(source, target, {
		bodyColumns: probe.bodyCols,
		generated: updateOp.generated,
		immutable: updateOp.immutable,
		scope: ctx.scope,
		set,
	})
	if (patch === null) return undefined
	const headers = uniqueProbeHeaders({
		header: updateOp.idempotencyHeader,
		required: probe.required,
		fresh: `oat-unique-patch-${ctx.entityName}-${ctx.seed}-${index}`,
	})
	const update = await updateRequest(ctx, updateOp, target, patch)
	const params = { ...ctx.scope, ...itemParamFor(ctx, made.scratch.id) }
	const sent = await ctx.client.request(update.method, fillPath(updateOp.path, params), {
		...update.options,
		as: { principal: ctx.actor.id },
		headers,
		operationId: updateOp.operationId,
	})
	await judgeUpdateProbe(ctx, probe, { before, method: update.method, sent, set })
	return undefined
}

async function judgeUpdateProbe(
	ctx: Listed<Client>,
	probe: UpdateProbe,
	{ before, method, sent, set }: { before: Listing; method: string; sent: Exchange; set: string[] },
): Promise<void> {
	const { check, updateOp } = probe
	if (standDownForFeatureGate(ctx, updateOp, sent, check)) return
	if (isPlanLimitResponse(sent.status, sent.responseBody)) {
		ctx.findings.gap(check, ctx.entityName, {
			summary: `${updateOp.operationId} did not apply`,
			detail:
				`${updateOp.operationId} returned ${sent.status} (plan limit) on a unique-conflict ` +
				"probe, so uniqueness was not observed.",
		})
		return
	}
	const after = await listAll(ctx, q(ctx, { limit: probe.listLimit }))
	const listResolved = before.exchange.status < 400 && before.complete
	if (sent.status === 409) {
		if (!listResolved || after.exchange.status >= 400 || !after.complete) return
		const around = { after: after.items, before: before.items, identity: ctx.identity, scope: ctx.scope }
		const leaked = leakedCollisions(set, probe.source, around)
		if (leaked.length > 0) {
			ctx.findings.backend(check, ctx.entityName, {
				summary: "a unique-conflict 409 still grew the collection",
				detail:
					`PATCH colliding ${set.join(", ")} returned 409 but the list grew from ` +
					`${before.items.length} to ${after.items.length}, by ${leaked.slice(0, 3).join(", ")}, ` +
					`which holds the colliding values.`,
				evidence: [before.exchange, sent, after.exchange],
			})
		}
		return
	}
	reportUpdateAnswer(ctx, probe, { method, sent, set })
}

/* A probe answered other than 409: accepted, crashed, or refused for another reason. */
function reportUpdateAnswer(
	ctx: WriteContext,
	{ check, updateOp }: UpdateProbe,
	{ method, sent, set }: { method: string; sent: Exchange; set: string[] },
): void {
	const moved =
		`${updateOp.operationId} returned ${sent.status} when ${method} moved a different row ` +
		`onto ${set.join(", ")} values already held by another row. A documented unique `
	if (sent.status >= 200 && sent.status < 300) {
		ctx.findings.backend(check, ctx.entityName, {
			summary: "a duplicate unique-set update was accepted",
			detail: `${moved}constraint must be 409, not 2xx.`,
			evidence: [sent],
		})
		return
	}
	if (sent.status >= 500) {
		ctx.findings.backend(check, ctx.entityName, {
			summary: "a duplicate unique-set update drew a server error",
			detail: `${moved}constraint must be refused with 409, not crash.`,
			evidence: [sent],
		})
		return
	}
	ctx.findings.unresolved(
		check,
		ctx.entityName,
		`unique ${method} for ${set.join(", ")} returned ${sent.status}, which is not a 409 unique conflict`,
	)
}
