import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord, scratchRecord, updateRequest } from "../../isolation/scratch.ts"
import { changedValue } from "../../payloads/body.ts"
import { judgeRefusal } from "../../planning/refusal.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"

export const immutableRejected = defineCheck<{
	field: string
	updateOp: OperationModel
	readOp: OperationModel
}>({
	plan: (ctx) => {
		const { updateOp, readOp } = ctx
		if (updateOp === undefined || readOp === undefined || ctx.createOp === undefined) return cannot()
		const field = updateOp.immutable.find((f) => f !== ctx.identity) ?? updateOp.immutable[0]
		return field === undefined ? cannot() : ready({ field, readOp, updateOp })
	},
	mutates: true,
	id: "patch.immutable-field-rejected",
	needs: "fields declared immutable via x-immutable",
	subjects: subjectsOf.update,
	async run(ctx, { field, readOp, updateOp }): Promise<Outcome> {
		/* Its own record: an immutable field is very often the tenant or parent key, and a backend
		 * that accepts the write moves the record out of the scope every later check reads. */
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const { id, record: target } = made.scratch
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }

		const probe = changedValue(ctx, field, target[field])
		if (probe === undefined) {
			return ctx.findings.unresolved(this.id, ctx.entityName, `no other valid value for "${field}" can be made`)
		}
		const update = await updateRequest(ctx, updateOp, target, { [field]: probe })
		const patched = await ctx.client.request(update.method, fillPath(updateOp.path, params), {
			...update.options,
			headers: ctx.auth(),
			operationId: updateOp.operationId,
		})
		if (standDownForFeatureGate(ctx, updateOp, patched, this.id))
			return standDown("a documented feature gate refused the request")
		const refused = judgeRefusal(ctx, this.id, ["validation", "conflict"], patched)
		if (refused !== null) return refused
		/* An accepted write to a key — a tenant, a parent — can move the record outside every scope oat
		 * can reach, whether or not the echo shows it. */
		ctx.recordMoved?.(
			ctx.entityName,
			id,
			`moved by a write to "${field}" the backend accepted (${updateOp.operationId})`,
		)

		/* Read the echoed record first. Re-reading can itself fail once the write lands — writing
		 * a tenant key, for instance, moves the record out of the caller's scope — and that
		 * failure would otherwise mask the very defect being probed. */
		const echoed = readRecord(updateOp, patched) ?? {}
		const after = await ctx.client.get(fillPath(readOp.path, params), { headers: ctx.auth() })
		const current = readRecord(readOp, after) ?? {}
		const accepted = echoed[field] === probe || current[field] === probe
		if (!accepted) return ASSERTED

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "a field declared immutable accepted a write",
			detail:
				`${update.method} set "${field}" to a client-supplied value and the change persisted. ` +
				"Server-owned fields must reject writes, not absorb them.",
			evidence: [patched, after],
		})
	},
})
