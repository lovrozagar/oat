import { defineCheck } from "../../core/define.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv, pageSize, q } from "../../query/capabilities.ts"
import { listAll, sameSet, setOf } from "../../sets/compare.ts"

export const searchTokensAnd = /* @__PURE__ */ defineCheck<{ a: string; b: string }>({
	plan: (ctx) => {
		const field = ctx.query?.searchable[0]
		if (conv(ctx).search === undefined || field === undefined || ctx.records.length <= 2) return cannot()
		const tokens: string[] = []
		for (const row of ctx.records) {
			const value = row[field]
			if (typeof value !== "string") continue
			/* As written: lowercasing it would match nothing on a case-sensitive search, and two
			 * empty sides agree vacuously. */
			const word = value.split(/\s+/).find((part) => part.length >= 3)
			if (word !== undefined) tokens.push(word)
		}
		const [a, b] = [...new Set(tokens)]
		return a === undefined || b === undefined
			? cannot("two discriminating search tokens in the cohort")
			: ready({ a, b })
	},
	dependsOn: ["pagination.page-walk-covers-set", "search.q-narrows-result"],
	id: "search.tokens-and",
	needs: "searchable fields and two tokens that split the cohort",
	subjects: subjectsOf.list,
	async run(ctx, { a, b }): Promise<Outcome> {
		const limit = pageSize(ctx)
		const onlyA = await listAll(ctx, q(ctx, { limit, search: a }))
		const onlyB = await listAll(ctx, q(ctx, { limit, search: b }))
		const both = await listAll(ctx, q(ctx, { limit, search: `${a} ${b}` }))
		if (onlyA.exchange.status >= 400 || onlyB.exchange.status >= 400 || both.exchange.status >= 400) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "a token search was rejected")
		}
		if (!onlyA.complete || !onlyB.complete || !both.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, "the sets are larger than a read covers")
		}
		const setA = setOf(onlyA.items, ctx.identity)
		const setB = setOf(onlyB.items, ctx.identity)
		if (setA.size === 0 || setB.size === 0) {
			return ctx.findings.unresolved(
				this.id,
				ctx.entityName,
				`a token taken from the cohort matched nothing (q="${setA.size === 0 ? a : b}"), so how two combine cannot be judged`,
			)
		}
		const expected = new Set([...setA].filter((id) => setB.has(id)))
		const got = setOf(both.items, ctx.identity)
		if (sameSet(expected, got) || sameSet(got, new Set([...setA, ...setB]))) return ASSERTED
		return ctx.findings.backend(
			this.id,
			ctx.entityName,
			"two search tokens are not applied as AND",
			`q="${a} ${b}" returned ${got.size}; the intersection of each token is ${expected.size}.`,
			[onlyA.exchange, onlyB.exchange, both.exchange],
		)
	},
})
