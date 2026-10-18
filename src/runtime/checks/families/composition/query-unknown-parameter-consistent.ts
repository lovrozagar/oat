import { defineCheck } from "../../core/define.ts"
import type { Exchange } from "../../../client.ts"
import { asserted, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { asProbe } from "../../planning/refusal.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { conv } from "../../query/capabilities.ts"
import { sameSet, setOf } from "../../sets/compare.ts"
import { readSet } from "../../sets/read.ts"

/**
 * A query parameter the API does not know is either refused or ignored — consistently.
 *
 * Both are defensible policies, and the document rarely says which. What is not defensible is a
 * name nobody declared changing the result: a caller who misspells `limit` gets a different set
 * and no error. Two invented names are sent — one plain, one shaped like a real parameter with a
 * typo — and each answer compared, as a whole set, with the listing asked for without it.
 */
export const unknownParameterConsistent = /* @__PURE__ */ defineCheck<{ names: string[] }>({
	plan: (ctx) => {
		if (ctx.records.length === 0) return cannot()
		const real = conv(ctx).limit ?? conv(ctx).page ?? conv(ctx).order ?? "limit"
		return ready({ names: ["oat_unknown_parameter", `${real}_oat_typo`] })
	},
	dependsOn: ["list.read-after-write", "pagination.page-walk-covers-set"],
	id: "query.unknown-parameter-consistent",
	needs: "a listing and at least one record",
	subjects: subjectsOf.list,
	async run(ctx, { names }): Promise<Outcome> {
		const baseline = await readSet(ctx, {}, { fresh: true })
		if (baseline.status !== "ok" || !baseline.complete) {
			return ctx.findings.unresolved(this.id, ctx.entityName, baseline.reason)
		}
		const expected = setOf(baseline.items, ctx.identity)
		const answers: Array<{ name: string; policy: "refused" | "ignored"; exchange: Exchange }> = []
		for (const name of names) {
			const probe = await readSet(asProbe(ctx), { [name]: "1" }, { fresh: true })
			const exchange = probe.last.exchange
			if (exchange.status >= 500) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"an unknown query parameter crashes the listing",
					`adding ?${name}=1, a parameter the document does not declare, returned ${exchange.status}.`,
					[exchange],
				)
			}
			if (exchange.status === 400 || exchange.status === 422) {
				answers.push({ exchange, name, policy: "refused" })
				continue
			}
			if (probe.status !== "ok" || !probe.complete) {
				return ctx.findings.unresolved(
					this.id,
					ctx.entityName,
					`?${name}=1 was answered with ${exchange.status}, which says nothing about the parameter`,
				)
			}
			if (!sameSet(setOf(probe.items, ctx.identity), expected)) {
				return ctx.findings.backend(
					this.id,
					ctx.entityName,
					"an unknown query parameter silently changes the result",
					`adding ?${name}=1, a parameter the document does not declare, returned ${probe.items.length} ` +
						`record(s) where the plain listing returns ${expected.size}, with no error. A caller who ` +
						"misspells a parameter gets a different answer and no way to know.",
					[baseline.last.exchange, exchange],
				)
			}
			answers.push({ exchange, name, policy: "ignored" })
		}
		const policies = new Set(answers.map((answer) => answer.policy))
		if (policies.size > 1) {
			return ctx.findings.backend(
				this.id,
				ctx.entityName,
				"unknown query parameters are handled inconsistently",
				answers.map((answer) => `?${answer.name}=1 was ${answer.policy} (${answer.exchange.status})`).join("; ") +
					". One unknown name refused and another ignored leaves callers guessing which mistakes are caught.",
				answers.map((answer) => answer.exchange),
			)
		}
		return asserted(`unknown query parameters are ${answers[0]?.policy ?? "ignored"} on the listing`)
	},
})
