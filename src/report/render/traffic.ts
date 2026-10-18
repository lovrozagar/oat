import type { Exchange } from "../../runtime/exchange.ts"
import type { ReportInput } from "./input.ts"

/** Checks named in the summary's cost line. */
export const COST_ROWS = 5

/** One check's share of the run: the requests it sent and its wall time. */
export interface CheckCost {
	check: string
	requests: number
	ms: number
}

/** Latency percentiles over the run, and where the slowest request went. */
export interface Latency {
	p50: number
	p95: number
	max: number
	slowest: { method: string; path: string }
}

/** Bytes sent, or received, over the whole transcript. */
export function utf8Total(transcript: readonly Exchange[], side: "request" | "response"): number {
	let total = 0
	for (const exchange of transcript) {
		total += side === "request" ? exchange.requestBytes : exchange.responseBytes
	}
	return total
}

/**
 * Latency percentiles over the run, and the single slowest request.
 *
 * A run is a few hundred requests against every read path an API has, which makes it a usable
 * sample of where time actually goes — and the slowest exchange is very often a route with a
 * missing index rather than a slow network. Reported, not asserted: oat has no baseline to judge
 * "too slow" against, and inventing a threshold would produce a finding nobody can act on.
 */
export function latency(transcript: readonly Exchange[]): Latency | null {
	if (transcript.length === 0) return null
	const sorted = [...transcript].sort((a, b) => a.durationMs - b.durationMs)
	/* Every index is inside a non-empty transcript. */
	const at = (fraction: number): number =>
		(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as Exchange).durationMs
	const slowest = sorted.at(-1) as Exchange
	return {
		max: slowest.durationMs,
		p50: at(0.5),
		p95: at(0.95),
		slowest: { method: slowest.method, path: new URL(slowest.url).pathname },
	}
}

/**
 * What each check cost: the requests it sent, counted from the transcript, and its wall time
 * summed over entities. Costliest first, by requests.
 */
export function costByCheck(input: ReportInput): CheckCost[] {
	const rows = new Map<string, CheckCost>()
	const row = (check: string): CheckCost => {
		const existing = rows.get(check)
		if (existing !== undefined) return existing
		const created = { check, ms: 0, requests: 0 }
		rows.set(check, created)
		return created
	}
	for (const exchange of input.client.transcript) if (exchange.check !== undefined) row(exchange.check).requests += 1
	for (const timing of input.checkTimings ?? []) row(timing.check).ms += timing.ms
	return [...rows.values()].sort((a, b) => b.requests - a.requests || b.ms - a.ms || a.check.localeCompare(b.check))
}
