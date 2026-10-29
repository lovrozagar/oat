import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import { readCacheSignals } from "../../../../client/cache-signals.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { asserted, type Outcome, standDown } from "../../../finding.ts"
import type { WriteContext } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { subjectsOf } from "../../planning/subjects.ts"
import { primedWrite, readAfter, type Step, type WriteKind, writeKinds } from "./freshness-write.ts"
import { stalenessSchedule, watchCapMs } from "./staleness-schedule.ts"
import { type Bracket, SYSTEM_CLOCK, type WatchClock, watchUntilFresh } from "./staleness-watch.ts"

const ID = "consistency.staleness-within-bound"

/** The clock the watch keeps; a test swaps it for one that only moves when the watch sleeps. */
export const STALENESS_TIMING: { clock: WatchClock } = { clock: SYSTEM_CLOCK }

/** One write and how long the read took to show it. */
interface Measured {
	kind: WriteKind
	path: string
	bracket: Bracket
	write: Exchange
}

/**
 * After a write, how long a read answers the old value: the read as a client sends it, past no
 * bypass, on `stalenessSchedule`. Past a declared `x-consistency.staleness` it is a finding; with
 * none declared the window is only reported, so an API that promises nothing is never failed on it.
 */
export const stalenessWithinBound: Check<{ readOp: OperationModel; kinds: WriteKind[] }> = defineCheck<{
	readOp: OperationModel
	kinds: WriteKind[]
}>({
	plan: (ctx) => {
		const { createOp, readOp } = ctx
		if (createOp === undefined || readOp === undefined) return cannot()
		const kinds = writeKinds(ctx)
		return kinds.length === 0
			? cannot("an update or a delete whose effect the read can show")
			: ready({ kinds, readOp })
	},
	mutates: true,
	id: ID,
	needs: "a create, an item read, and an update or a delete",
	subjects: subjectsOf.writeAndRead,
	async run(ctx, { kinds, readOp }): Promise<Outcome> {
		const boundMs = readOp.consistency?.stalenessMs ?? null
		const measured: Measured[] = []
		let refused: Outcome | undefined
		for (const kind of kinds) {
			const step = await measure(ctx, { boundMs, kind, readOp })
			if ("outcome" in step) refused ??= step.outcome
			else measured.push(step)
		}
		if (measured.length === 0) return refused ?? standDown("no write could be measured")
		return judge(ctx, measured, boundMs)
	},
})

async function measure(
	ctx: WriteContext,
	ask: { kind: WriteKind; readOp: OperationModel; boundMs: number | null },
): Promise<Step<Measured>> {
	const written = await primedWrite(ctx, { check: ID, kind: ask.kind, readOp: ask.readOp })
	if ("outcome" in written) return written
	const capMs = watchCapMs(ask.boundMs)
	let pastStatus = 0
	const bracket = await watchUntilFresh({
		capMs,
		clock: STALENESS_TIMING.clock,
		fresh: written.shows,
		read: () => ctx.client.get(written.path, { ...readAfter(written), as: { principal: ctx.actor.id }, cache: "use" }),
		schedule: stalenessSchedule(capMs),
		/* A stale read is a cache's doing only if a read past every cache shows the write. */
		showsPastCache: async () => {
			const past = await ctx.client.get(written.path, { ...readAfter(written), as: { principal: ctx.actor.id } })
			pastStatus = past.status
			return written.shows(past)
		},
	})
	if (bracket.neverTook) {
		return {
			outcome: standDown(
				`a read past the cache answers ${pastStatus} too, so the ${ask.kind} never showed and no cache is to blame`,
			),
		}
	}
	return { bracket, kind: ask.kind, path: written.path, write: written.write }
}

/** What a stale answer said about the cache that gave it. */
function cacheEvidence(stale: Exchange | null): string {
	if (stale === null) return ""
	const { ageS, status } = readCacheSignals(stale.responseHeaders)
	const said = [
		...status.map((entry) => `Cache-Status ${entry.cache} ${entry.hit ? "hit" : `fwd=${entry.fwd ?? "?"}`}`),
		...(ageS === null ? [] : [`Age ${ageS}`]),
	]
	return said.length === 0 ? "" : `; the stale answer said ${said.join(", ")}`
}

function windowOf({ bracket, kind }: Measured): string {
	if (bracket.staleAtMs === null) return `after the ${kind} the read showed it at once`
	if (bracket.freshAtMs === null) return `after the ${kind} the read was still stale at ${bracket.staleAtMs}ms`
	return `after the ${kind} the read showed it at ${bracket.freshAtMs}ms (still stale at ${bracket.staleAtMs}ms)`
}

function judge(ctx: WriteContext, measured: readonly Measured[], boundMs: number | null): Outcome {
	const windows = measured.map(windowOf).join("; ")
	if (boundMs === null) return asserted(`${windows}; no staleness is declared, so the window is reported, not judged`)
	const over = measured.find((m) => m.bracket.freshAtMs === null)
	if (over === undefined) return asserted(`${windows}, within the declared ${boundMs}ms`)
	/* Stale at the longest watch, still short of a longer bound: noted, never judged past it. */
	if ((over.bracket.staleAtMs ?? 0) < boundMs) {
		return asserted(`${windows}, the longest oat watches; the declared ${boundMs}ms is not judged past it`)
	}
	return ctx.findings.backend(ID, ctx.entityName, {
		detail:
			`${windowOf(over)}: GET ${over.path} answered the old ${over.kind === "delete" ? "record" : "value"} ` +
			`past the ${boundMs}ms its x-consistency.staleness declares, no fresh read within it${cacheEvidence(over.bracket.stale)}`,
		evidence: [over.write, ...(over.bracket.stale === null ? [] : [over.bracket.stale])],
		summary: "a cached read stayed stale past the staleness it declares",
	})
}
