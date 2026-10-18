import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { scratchRecord } from "../../isolation/scratch.ts"
import { standDownForFeatureGate } from "../../planning/stand-down.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"
import { ids } from "../../sets/list.ts"
import { readSet } from "../../sets/read.ts"

export const softDeleteHidden = defineCheck<{ deleteOp: OperationModel }>({
	plan: (ctx) => {
		if (ctx.deleteOp === undefined || ctx.softDelete === null || ctx.createOp === undefined) return cannot()
		return ready({ deleteOp: ctx.deleteOp })
	},
	mutates: true,
	/* The evidence for a tombstone leak is the record still being *in the listing*. On a backend
	 * whose listing already omits records it should contain, "absent" proves nothing. */
	dependsOn: ["pagination.page-walk-covers-set", "list.read-after-write"],
	id: "softdelete.absent-from-default-list",
	needs: "a create, a delete operation and x-soft-delete",
	subjects: subjectsOf.deleteAndList,
	async run(ctx, { deleteOp }): Promise<Outcome> {
		const made = await scratchRecord(ctx, this.id)
		if ("outcome" in made) return made.outcome
		const id = made.scratch.id
		const params = { ...ctx.scope, ...itemParamFor(ctx, id) }
		const deleted = await ctx.client.request("DELETE", fillPath(deleteOp.path, params), {
			headers: ctx.auth(),
		})
		if (standDownForFeatureGate(ctx, deleteOp, deleted, this.id))
			return standDown("a documented feature gate refused the request")
		if (deleted.status >= 300) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`DELETE returned ${deleted.status}, so no tombstone was created to look for`,
			)
		}

		/* Absence is only proven over the whole listing: a tombstone on page three is still there. */
		const after = await readSet(ctx, {}, { fresh: true })
		if (after.status !== "ok") {
			return ctx.findings.unresolved(this.id, ctx.entityName, after.reason)
		}
		if (!ids(after.items, ctx.identity).includes(id)) {
			if (after.complete) return ASSERTED
			return ctx.findings.unresolved(this.id, ctx.entityName, "the listing is larger than a read covers")
		}
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"soft-deleted record still appears in the default listing",
			`${ctx.entityName} ${id} was deleted (tombstoned via "${ctx.softDelete}") but the default ` +
				"list still returns it. Tombstones must be excluded unless explicitly requested.",
			[deleted, after.last.exchange],
		)
	},
})
