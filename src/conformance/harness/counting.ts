/**
 * How many requests a leg of the self-test sends, and who sent them: counted where each request
 * leaves for its target, and attributed from each run's own transcript. Each exchange says which
 * check, purpose or credential store issued it, and the progress the run published says which stage
 * an exchange that says none of that was sent in. Nothing is inferred from timing or estimated.
 */

import type { ProgressHandler, ProgressSnapshot } from "../../runtime/progress/types.ts"
import { run as runOat, type RunOptions, type RunResult } from "../../runtime/run/index.ts"
import type { Hosted, Via } from "./launch.ts"

/** What an exchange says about who sent it; a run's transcript holds one per request it made. */
export interface Sent {
	method: string
	check?: string
	purpose?: string
	issuedBy?: string
	/** The hops a followed redirect made: each was a call of its own. */
	redirects?: readonly unknown[]
}

/** Where a run's stage changed: the transcript's length when it did, and the stage it moved to. */
export interface Mark {
	at: number
	stage: string
}

const SAFE: ReadonlySet<string> = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"])

/** A request's purpose, when no check or credential store claims it. */
const BY_PURPOSE: Readonly<Record<string, string>> = {
	assertion: "lanes",
	auth: "auth",
	seed: "seed",
	teardown: "teardown",
}

/*
 * The stage a progress move is in. The contract floor enters "test" with no check, which a lane never
 * does, then "contract"; the scenarios have their own phase. Every other stage goes by its phase.
 */
function stageOf(snap: ProgressSnapshot): string {
	if (snap.phase === "contract" || (snap.phase === "test" && snap.check === undefined)) return "contract floor"
	if (snap.phase === "scenario") return "scenarios"
	return `phase ${snap.phase}`
}

/** A progress listener for one run, and the stage marks it has collected. */
export function marker(): { onProgress: ProgressHandler; marks: Mark[] } {
	const marks: Mark[] = []
	return {
		marks,
		onProgress: (snap) => {
			const stage = stageOf(snap)
			if (marks.at(-1)?.stage !== stage) marks.push({ at: snap.requests, stage })
		},
	}
}

/*
 * One exchange's source. A security stage's probe without a check is its own overhead: a GET reads a
 * target back, a write makes a throwaway to aim at. The store's requests are its own whatever they are for.
 */
function sourceOf(sent: Sent, stage: string): string {
	if (sent.issuedBy === "credentials") return "credentials"
	if (sent.check !== undefined) return `check ${sent.check}`
	if (sent.purpose === "probe") return SAFE.has(sent.method) ? "security overhead" : "throwaway creates"
	return (sent.purpose === undefined ? undefined : BY_PURPOSE[sent.purpose]) ?? stage
}

/** The requests in `transcript` per source, each counted once per call it made. */
export function sourcesOf(transcript: readonly Sent[], marks: readonly Mark[]): Record<string, number> {
	const sources: Record<string, number> = {}
	let next = 0
	let stage = "phase load"
	for (const [index, sent] of transcript.entries()) {
		while (next < marks.length && (marks[next] as Mark).at <= index) stage = (marks[next++] as Mark).stage
		const source = sourceOf(sent, stage)
		sources[source] = (sources[source] ?? 0) + 1 + (sent.redirects?.length ?? 0)
	}
	return sources
}

/** A leg's requests: all of them, and how many each source sent. */
export interface Requests {
	total: number
	/**
	 * Per source, summing to `total`. `unattributed` is what no run's transcript holds: a document
	 * load, a probe of the base URL, a suite's own call, or a run that threw before it answered.
	 */
	sources: Readonly<Record<string, number>>
}

/** A way to reach things that counts, and the count so far. */
export interface Counted {
	via: Via
	/** Every request sent to whatever `via` launched or hosted, since the counter began. */
	requests: () => Requests
}

/** A counted transport: it takes the sources of a run that went through it. */
interface Attributing {
	attribute: (sources: Readonly<Record<string, number>>) => void
}

function attributing(transport: unknown): transport is Attributing {
	return typeof transport === "function" && "attribute" in transport
}

/** `tallies` added up, source by source. */
export function sumRequests(tallies: readonly Requests[]): Requests {
	const sources: Record<string, number> = {}
	for (const tally of tallies)
		for (const [source, count] of Object.entries(tally.sources)) sources[source] = (sources[source] ?? 0) + count
	return { sources, total: tallies.reduce((sum, tally) => sum + tally.total, 0) }
}

/** A leg's `requests:` line, and under it each source, sorted by name. */
export function requestLines(requests: Requests): string {
	const sources = Object.entries(requests.sources)
		.filter(([, count]) => count > 0)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([source, count]) => `    ${source}: ${count}\n`)
	return `  requests: ${requests.total}\n${sources.length === 0 ? "" : `  requests by source:\n${sources.join("")}`}`
}

/**
 * `via`, counting each request oat sends to what it launches or hosts: through that thing's own
 * transport, or through `socket` when it is reached behind one. A leg counts the same way on
 * either transport, so its request volume compares across runs.
 */
export function counting(via: Via, socket: typeof fetch = globalThis.fetch): Counted {
	let total = 0
	const attributed: Requests[] = []
	const attribute = (sources: Readonly<Record<string, number>>): void => {
		attributed.push({ sources, total: Object.values(sources).reduce((sum, count) => sum + count, 0) })
	}
	const counted = <T extends Hosted>(hosted: T): T => {
		const inner = hosted.fetch ?? socket
		const send = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
			total += 1
			return inner(input, init)
		}
		return { ...hosted, fetch: Object.assign(send, { attribute }) }
	}
	return {
		requests: () => {
			const runs = sumRequests(attributed)
			const unattributed = total - runs.total
			return { sources: unattributed === 0 ? runs.sources : { ...runs.sources, unattributed }, total }
		},
		via: {
			host: async (handle) => counted(await via.host(handle)),
			launch: async (backend, options) => counted(await via.launch(backend, options)),
		},
	}
}

/**
 * oat's run, as every conformance leg sends it. A run whose transport a counter wraps hands that
 * counter its requests by source once it answers: read from its transcript and the stages its
 * progress passed through, so attributing them sends nothing.
 */
export async function run(options: RunOptions): Promise<RunResult> {
	const transport = options.network?.fetch
	if (!attributing(transport)) return runOat(options)
	const progress = marker()
	const result = await runOat({
		...options,
		onProgress: (snap) => {
			progress.onProgress(snap)
			options.onProgress?.(snap)
		},
	})
	transport.attribute(sourcesOf(result.client.transcript, progress.marks))
	return result
}
