import { defineCheck } from "../../core/define.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { itemParamFor } from "../../planning/subjects.ts"

function listedRowMatches(listed: Record<string, unknown>, body: unknown): boolean {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return false
	const got = body as Record<string, unknown>
	return Object.entries(listed).every(([key, value]) => JSON.stringify(got[key]) === JSON.stringify(value))
}

/** A list with no create still has a get. The get body is the row the list already returned. */
export const listedRowIsTheGet = defineCheck<{ id: string; listed: Record<string, unknown> }>({
	plan: (ctx) => {
		if (ctx.readOp === undefined || ctx.createOp !== undefined) return cannot()
		const listed = ctx.records[0]
		const id = listed?.[ctx.identity]
		if (listed === undefined || (typeof id !== "string" && typeof id !== "number")) {
			return cannot("the list returned no id")
		}
		return ready({ id: String(id), listed })
	},
	id: "list.item-matches-listed-row",
	needs: "a list with no create and one listed row",
	subjects: (entity) => (entity.read === undefined ? [] : [entity.read]),
	async run(ctx, { id, listed }): Promise<Outcome> {
		const op = ctx.readOp
		if (op === undefined) return standDown("the entity has no read")
		const item = await ctx.client.get(fillPath(op.path, { ...ctx.scope, ...itemParamFor(ctx, id) }), {
			as: { principal: ctx.actor.id },
			operationId: op.operationId,
		})
		if (item.status >= 300) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "the listed row is not returned by its get",
				detail: `${op.operationId} returned ${item.status} for ${ctx.entityName} ${id}`,
				evidence: [item],
			})
		}
		if (!listedRowMatches(listed, item.responseBody)) {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "the get body is not the listed row",
				detail: `${op.operationId} returned a body that does not contain the row ${ctx.listOp?.operationId ?? "the list"} already returned for ${id}`,
				evidence: [item],
			})
		}
		return ASSERTED
	},
})
