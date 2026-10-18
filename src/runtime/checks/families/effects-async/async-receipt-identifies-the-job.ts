import { defineCheck } from "../../core/define.ts"
import { resolveAsyncId } from "../../../async.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { when } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { forOperation } from "./requests.ts"

export const asyncReceiptIsResolvable = defineCheck({
	plan: (ctx) => when(ctx.asyncOps.some((op) => op.async?.idFrom !== undefined)),
	id: "async.receipt-identifies-the-job",
	judgesTranscript: true,
	needs: "x-async with an idFrom pointer",
	subjects: subjectsOf.asyncReceipt,
	async run(all): Promise<Outcome> {
		for (const op of all.asyncOps) {
			const ctx = forOperation(all, op)
			const spec = op.async
			if (spec?.idFrom === undefined) continue

			/* Match the async operation's own exchange by resolved path — any POST would do here
			 * otherwise, and a sibling create's response would be inspected instead. */
			let resolved: string
			try {
				resolved = fillPath(op.path, ctx.scope)
			} catch {
				continue
			}
			const attempts = ctx.client
				.exchangesFor(op.operationId)
				.filter((e) => ctx.client.relativePath(e.url) === resolved)
			const started = attempts.find((e) => e.status > 0 && e.status < 300)
			if (started === undefined) {
				/* The action never answered with a receipt: say so rather than pass in silence. */
				const refused = attempts.at(-1)
				if (refused !== undefined) {
					ctx.findings.unresolved(
						this.id,
						ctx.entityName,
						`${op.operationId} answered ${refused.status === 0 ? "nothing" : refused.status}, so there was no receipt to read`,
					)
				}
				continue
			}

			const node = resolveAsyncId((await ctx.client.hydrate(started)).responseBody, spec.idFrom)
			if (node !== undefined && node !== null) continue

			ctx.findings.spec(this.id, ctx.entityName, {
				summary: `${op.operationId} response does not carry the job identifier it declares`,
				detail:
					`x-async names "${spec.idFrom}" as the job id, but the response has no such value. ` +
					"Callers cannot poll for a job they cannot name.",
				evidence: [started],
			})
		}
		return ASSERTED
	},
})
