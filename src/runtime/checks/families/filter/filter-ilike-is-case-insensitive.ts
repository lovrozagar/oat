import { defineCheck } from "../../core/define.ts"
import { filterTerm } from "../../../../spec/conventions/filter.ts"
import type { EffectiveFilterField } from "../../../../spec/query/effective.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { idOf } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { canUseOp, conv, FOUNDATIONS, pageSize, q } from "../../query/capabilities.ts"
import { listAll } from "../../sets/compare.ts"
import { ids } from "../../sets/list.ts"
import { fieldsAllowing } from "./fields.ts"

export const filterIlikeIsCaseInsensitive = defineCheck<{
	field: EffectiveFilterField
	sample: string
	flipped: string
	likeTerm: Record<string, string>
	ilikeTerm: Record<string, string>
}>({
	plan: (ctx) => {
		const field = fieldsAllowing(ctx, "ilike").find((item) => canUseOp(ctx, item, "like"))
		if (field === undefined) return cannot()
		const sample = ctx.records
			.map((row) => row[field.field])
			.find((value): value is string => typeof value === "string" && /[A-Za-z]/.test(value))
		if (sample === undefined) return cannot(`a cohort value of "${field.field}" holding a letter to case-flip`)
		const flipped = sample.replace(/[A-Za-z]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
		const conventions = conv(ctx)
		const likeTerm = filterTerm(conventions, field.field, "like", flipped)
		const ilikeTerm = filterTerm(conventions, field.field, "ilike", flipped)
		if (likeTerm === null || ilikeTerm === null) return cannot("a filter grammar that can express like and ilike")
		return ready({ field, flipped, ilikeTerm, likeTerm, sample })
	},
	dependsOn: ["query.filter-selects-from-whole-set", ...FOUNDATIONS, "filter.like-metacharacters-escaped"],
	id: "filter.ilike-is-case-insensitive",
	needs: "a field that allows both `ilike` and `like`, and a string with a letter",
	subjects: subjectsOf.list,
	async run(ctx, { field, flipped, ilikeTerm, likeTerm, sample }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const like = await listAll(ctx, { ...q(ctx, { limit }), ...likeTerm })
		const ilike = await listAll(ctx, { ...q(ctx, { limit }), ...ilikeTerm })
		if (like.exchange.status >= 400 || ilike.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "like/ilike probe was rejected")
		}
		if (!like.complete || !ilike.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		const likeHits = ids(like.items, ctx.identity)
		const ilikeHits = ids(ilike.items, ctx.identity)
		const original = ctx.records
			.filter((row) => row[field.field] === sample)
			.flatMap((row) => idOf(row, ctx.identity) ?? [])
		if (original.some((id) => ilikeHits.includes(id)) && !original.some((id) => likeHits.includes(id))) return ASSERTED
		if (original.some((id) => ilikeHits.includes(id)) && original.some((id) => likeHits.includes(id))) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				"like also matched the case-flipped value — the store may already be case-insensitive",
			)
		}
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "ilike is not case-insensitive relative to like",
			detail: `ilike on ${JSON.stringify(flipped)} did not select the record whose ${field.field} is ${JSON.stringify(sample)}.`,
			evidence: [like.exchange, ilike.exchange],
		})
	},
})
