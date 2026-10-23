import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, MOVING, pageSize, q, resolvedCaps } from "../../query/capabilities.ts"
import { listAgain, listAll, sameSet, setOf, settlePair } from "../../sets/compare.ts"

export const searchCaseInsensitive: Check<{ token: string; flipped: string }> = defineCheck<{
	token: string
	flipped: string
}>({
	plan: (ctx) => {
		if (conv(ctx).search === undefined) return cannot()
		/* The first word with a letter, searchable field by field and record by record: a word of
		 * the first text value that holds a letter at all. */
		const token = (ctx.query?.searchable ?? [])
			.flatMap((field) => ctx.records.map((row) => row[field]))
			.filter((value): value is string => typeof value === "string")
			.flatMap((value) => value.split(/\s+/))
			.find((part) => /[A-Za-z]/.test(part))
		if (token === undefined) return cannot()
		const flipped = token.replace(/[A-Za-z]/, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
		return ready({ flipped, token })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result"],
	id: "search.case-insensitive",
	needs: "a searchable string with a letter",
	subjects: subjectsOf.list,
	async run(ctx, { flipped, token }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const query = (term: string) => q(ctx, { limit, search: term })
		const first = await listAll(ctx, query(token))
		const second = await listAll(ctx, query(flipped))
		if (first.exchange.status >= 400 || second.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a case-flipped search was rejected")
		}
		if (!first.complete || !second.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		/* A record written between the two searches is the collection moving, not case mattering. */
		const settled = await settlePair(
			ctx.identity,
			{ first, second },
			{
				first: () => listAgain(ctx, query(token)),
				second: () => listAgain(ctx, query(flipped)),
			},
		)
		if (settled === null) return ctx.findings.unresolved(this.id, ctx.entityName, "a case-flipped search was rejected")
		if (settled === "moving") return ctx.findings.unresolved(this.id, ctx.entityName, MOVING)
		const { first: original, second: other } = settled
		const a = setOf(original.items, ctx.identity)
		const b = setOf(other.items, ctx.identity)
		if (sameSet(a, b)) return ASSERTED
		if (resolvedCaps(ctx).searchCase === "insensitive") {
			return ctx.findings.backend(this.id, ctx.entityName, {
				summary: "search is not case-insensitive",
				detail: `q=${JSON.stringify(token)} and q=${JSON.stringify(flipped)} selected different sets.`,
				evidence: [original.exchange, other.exchange],
			})
		}
		return ctx.findings.unresolved(
			this.id,
			ctx.entityName,
			"case-flipped search selected a different set; declare searchCase: insensitive to treat that as a defect",
		)
	},
})
