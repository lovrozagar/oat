import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { itemParamFor } from "../../planning/subjects.ts"

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

const shown = (value: unknown): string => (value === undefined ? "nothing" : JSON.stringify(value))

/**
 * Where the get disagrees with a value the listed row shows. An object is judged by the keys the
 * row shows, at any depth, so a get may carry fields a list projection leaves out. An array is a
 * value of its own: the get must hold as many elements, each judged by the same rule in order.
 */
function differences(listed: unknown, got: unknown, path: string): string[] {
	if (isObject(listed) && isObject(got)) {
		return Object.entries(listed).flatMap(([key, value]) =>
			differences(value, got[key], path === "" ? key : `${path}.${key}`),
		)
	}
	if (Array.isArray(listed) && Array.isArray(got) && listed.length === got.length) {
		return listed.flatMap((value, index) => differences(value, got[index], `${path}[${index}]`))
	}
	if (JSON.stringify(listed) === JSON.stringify(got)) return []
	return [`${path} listed ${shown(listed)}, got ${shown(got)}`]
}

/** A list with no create still has a get. The get body is the row the list already returned. */
export const listedRowIsTheGet: Check<{ id: string; listed: Record<string, unknown> }> = defineCheck<{
	id: string
	listed: Record<string, unknown>
}>({
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
		const body = item.responseBody
		const differ = isObject(body) ? differences(listed, body, "") : []
		if (!isObject(body) || differ.length > 0) {
			const named = differ.slice(0, 4).join("; ") + (differ.length > 4 ? `; and ${differ.length - 4} more` : "")
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "the get body is not the listed row",
				detail:
					`${op.operationId} returned a body that does not contain the row ${ctx.listOp?.operationId ?? "the list"} already returned for ${id}` +
					(named === "" ? "" : `: ${named}`),
				evidence: [item],
			})
		}
		return ASSERTED
	},
})
