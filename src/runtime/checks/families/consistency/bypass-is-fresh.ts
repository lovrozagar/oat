import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { readCacheSignals } from "../../../../client/cache-signals.ts"
import type { CacheBypass } from "../../../../spec/extensions/consistency.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { ASSERTED, type Outcome } from "../../../finding.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { primedWrite, writeKinds } from "./freshness-write.ts"

const ID = "consistency.bypass-is-fresh"

/** What the answer's `Cache-Status` lists, as the finding repeats it. */
function cacheStatusOf(answer: Exchange): string {
	const { status } = readCacheSignals(answer.responseHeaders)
	const said = status.map((entry) => `${entry.cache} ${entry.hit ? "hit" : `fwd=${entry.fwd ?? "?"}`}`)
	return said.length === 0 ? "" : `; Cache-Status ${said.join(", ")}`
}

/**
 * A read's declared bypass skips every cache: right after a write, one read sent the bypass shows
 * the write, and no cache on the way says it answered (`Cache-Status: …; hit`, RFC 9211).
 */
export const bypassIsFresh: Check<{ readOp: OperationModel; bypass: CacheBypass }> = defineCheck<{
	readOp: OperationModel
	bypass: CacheBypass
}>({
	plan: (ctx) => {
		const { createOp, readOp } = ctx
		const bypass = readOp?.consistency?.bypass ?? null
		if (readOp === undefined || bypass === null) return cannot("a read that declares an x-consistency bypass")
		if (ctx.cacheBypass === false) return cannot("the cache bypass, which config cache.bypass turns off")
		if (createOp === undefined || writeKinds(ctx).length === 0) return cannot("a create, and an update or a delete")
		return ready({ bypass, readOp })
	},
	mutates: true,
	id: ID,
	needs: "a read that declares an x-consistency bypass, a create, and an update or a delete",
	subjects: subjectsOf.writeAndRead,
	async run(ctx, { bypass, readOp }): Promise<Outcome> {
		const kind = writeKinds(ctx)[0] as "update" | "delete"
		const written = await primedWrite(ctx, { check: ID, kind, readOp })
		if ("outcome" in written) return written.outcome
		/* Sent as the caller's own header, so the read carries it whatever layers the client adds. */
		const answer = await ctx.client.get(written.path, {
			as: { principal: ctx.actor.id },
			headers: { [bypass.name]: bypass.value },
		})
		const hit = readCacheSignals(answer.responseHeaders).status.some((entry) => entry.hit)
		const shows = written.shows(answer)
		if (shows && !hit) return ASSERTED
		const what = shows ? "a cache hit" : `the old ${kind === "delete" ? "record" : "value"}`
		return ctx.findings.backend(ID, ctx.entityName, {
			detail: `right after the ${kind}, GET ${written.path} sent ${bypass.name}: ${bypass.value} answered ${what}${cacheStatusOf(answer)}`,
			evidence: [written.write, answer],
			summary: "a read sent its declared cache bypass did not skip the cache",
		})
	},
})
