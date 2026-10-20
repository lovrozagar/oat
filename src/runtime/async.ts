/**
 * Async operation support.
 *
 * `x-async` means the HTTP response is a receipt, then oat polls. A `text/event-stream` body is
 * the result itself — parse events, do not `JSON.parse` the raw string. Poll only when the
 * stream ends without a terminal frame and `idFrom` resolved.
 */

import { readPath } from "../client/read-path.ts"
import type { AsyncSpec } from "../spec/extensions/async.ts"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import { type SseEvent, sseEvents } from "./sse.ts"
import { fillPath } from "./fill-path.ts"

/** What polling saw, however it ended. */
interface Polled {
	exchanges: Exchange[]
	polls: number
	elapsedMs: number
	timedOut: boolean
	/** Terminal state reached, or null otherwise. */
	terminal: Record<string, unknown> | null
}

/**
 * How polling ended: a terminal state, met or failing `successWhen`; the job vanished after it had
 * been served; the poll path could not be filled, so the job was never asked about; or time ran out.
 */
export type AsyncOutcome = Polled &
	(
		| { state: "terminal"; succeeded: true }
		/** `unmet`: the `successWhen` the terminal state did not satisfy. */
		| { state: "terminal"; succeeded: false; unmet: string }
		/** `unfillable`: why the poll path could not be filled. */
		| { state: "unfillable"; succeeded: false; unfillable: string }
		| { state: "vanished"; succeeded: false }
		| { state: "timed-out"; succeeded: false }
	)

/**
 * A single PostgREST-style predicate, reused here so `until`/`successWhen` speak the same
 * language as the filter grammar rather than inventing a second one.
 */
export function matchesPredicate(record: Record<string, unknown>, expression: string): boolean {
	const segments = expression.split(".")
	if (segments.length < 3) return false
	const [field, op] = segments as [string, string, ...string[]]
	const raw = segments.slice(2).join(".")
	const actual = record[field]

	switch (op) {
		case "eq":
			return String(actual) === raw
		case "neq":
			return String(actual) !== raw
		case "in":
			return raw
				.replace(/^\(|\)$/g, "")
				.split(",")
				.map((s) => s.trim())
				.includes(String(actual))
		case "is":
			if (raw === "null") return actual === null || actual === undefined
			if (raw === "true") return actual === true
			if (raw === "false") return actual === false
			return false
		default:
			return false
	}
}

function recordOf(data: unknown): Record<string, unknown> | null {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return null
	return data as Record<string, unknown>
}

/**
 * Resolve `idFrom` against a JSON receipt, or against each SSE event's JSON `data` (first hit).
 */
export function resolveAsyncId(receipt: unknown, idFrom: string): unknown {
	const events = sseEvents(receipt)
	if (events !== null) {
		for (const ev of events) {
			const record = recordOf(ev.data)
			if (record === null) continue
			const found = readPath(record, idFrom)
			if (found !== undefined && found !== null) return found
		}
		return undefined
	}
	return readPath(receipt, idFrom)
}

export interface StreamAsyncView {
	id: unknown
	/** Event data that carried `idFrom`, for binding the poll path. */
	idRecord: Record<string, unknown> | null
	/** `complete` / `error` frame, or a frame whose `data` matches `until`. */
	terminal: Record<string, unknown> | null
	events: SseEvent[]
}

/** Read job id and terminal state from SSE frames. `null` when the body is not a stream. */
export function inspectStreamAsync(receipt: unknown, spec: AsyncSpec): StreamAsyncView | null {
	const events = sseEvents(receipt)
	if (events === null) return null

	let id: unknown
	let idRecord: Record<string, unknown> | null = null
	let terminal: Record<string, unknown> | null = null
	for (const ev of events) {
		const record = recordOf(ev.data)
		if (record === null) continue
		if (id === undefined && spec.idFrom !== undefined) {
			const found = readPath(record, spec.idFrom)
			if (found !== undefined && found !== null) {
				id = found
				idRecord = record
			}
		}
		const named = ev.event === "complete" || ev.event === "error"
		const untilHit = spec.until !== undefined && matchesPredicate(record, spec.until)
		if (named || untilHit) terminal = record
	}
	return { events, id, idRecord, terminal }
}

/** What a job's poll needs: the start's receipt, where to poll, and who polls. */
export interface AsyncDrive {
	client: Client
	spec: AsyncSpec
	receipt: unknown
	scope: Record<string, string>
	/**
	 * Every poll goes as this principal continuing from `start`, its credential resolved afresh, so a long
	 * job never sends a dead one, and an undocumented poll URL sends what the start sent.
	 */
	principal: string
	/** The request that began the job. */
	start: Exchange
	/** Resolves a `poll` that names an operation rather than spelling `"GET /path"`. */
	operation?: ((operationId: string) => { method: string; path: string } | undefined) | undefined
}

/** The polls so far, and when polling began. */
interface Polling {
	began: number
	exchanges: Exchange[]
	polls: number
}

/** The caller's scope, plus the job id the receipt names bound to whichever poll-path parameter is unresolved. */
function pollScopeOf(spec: AsyncSpec, receipt: unknown, scope: Record<string, string>): Record<string, string> {
	const pollScope = { ...scope }
	if (spec.idFrom === undefined) return pollScope
	const id = resolveAsyncId(receipt, spec.idFrom)
	if (id === undefined || id === null) return pollScope
	const parameters = (spec.poll.match(/\{[^}]+\}/g) ?? []).map((parameter) => parameter.slice(1, -1))
	const unbound = parameters.find((name) => pollScope[name] === undefined)
	pollScope[unbound ?? spec.idFrom.replace(/^\$\./, "")] = String(id)
	return pollScope
}

/** The poll's method and path template: spelled `"GET /path"`, or the operation `poll` names. */
function pollRoute(input: AsyncDrive): { method: string; template: string } {
	const { spec } = input
	const named = spec.poll.includes("/") ? undefined : input.operation?.(spec.poll)
	if (named !== undefined) return { method: named.method.toUpperCase(), template: named.path }
	const [method, template = spec.poll] = spec.poll.split(" ") as [string, ...string[]]
	return { method, template }
}

async function pollOnce(input: AsyncDrive, method: string, path: string): Promise<Exchange> {
	return input.client.request(method, path, { as: { principal: input.principal, via: input.start } })
}

function terminalOutcome(spec: AsyncSpec, record: Record<string, unknown>, run: Polling): AsyncOutcome {
	const polled = {
		elapsedMs: performance.now() - run.began,
		exchanges: run.exchanges,
		polls: run.polls,
		terminal: record,
		timedOut: false,
	}
	return spec.successWhen === undefined || matchesPredicate(record, spec.successWhen)
		? { ...polled, state: "terminal", succeeded: true }
		: { ...polled, state: "terminal", succeeded: false, unmet: spec.successWhen }
}

function unfinished(run: Polling, state: "vanished" | "timed-out"): AsyncOutcome {
	return {
		elapsedMs: performance.now() - run.began,
		exchanges: run.exchanges,
		polls: run.polls,
		state,
		succeeded: false,
		terminal: null,
		timedOut: state === "timed-out",
	}
}

/** How one answer ends polling, or `undefined` while the job is still running. */
function settledBy(spec: AsyncSpec, exchange: Exchange, run: Polling): AsyncOutcome | undefined {
	if (exchange.status < 300) {
		const body = exchange.responseBody
		if (body === null || typeof body !== "object") return undefined
		const record = body as Record<string, unknown>
		const done = spec.until === undefined || matchesPredicate(record, spec.until)
		return done ? terminalOutcome(spec, record, run) : undefined
	}
	/* The job was served and then was not — a vanished job, and reporting it as a timeout
	 * would name the wrong problem. */
	return exchange.status === 404 && run.exchanges.some((prior) => prior.status < 300)
		? unfinished(run, "vanished")
		: undefined
}

/**
 * Polls until `until` matches, the timeout expires, or the poll route stops responding.
 *
 * Polling is capped by wall-clock rather than attempt count so a slow backend and a fast one
 * behave the same way, and the interval is fixed rather than exponential — the point is to
 * observe when the state changes, not to be gentle with an API oat is already hammering.
 */
export async function driveAsync(input: AsyncDrive): Promise<AsyncOutcome> {
	const run: Polling = { began: performance.now(), exchanges: [], polls: 0 }
	const pollScope = pollScopeOf(input.spec, input.receipt, input.scope)
	const { method, template } = pollRoute(input)
	let path: string
	try {
		path = fillPath(template, pollScope)
	} catch (error) {
		/* `fillPath` throws only a `SeedError`, naming the parameter it had no value for. */
		return {
			elapsedMs: performance.now() - run.began,
			exchanges: run.exchanges,
			polls: 0,
			state: "unfillable",
			succeeded: false,
			terminal: null,
			timedOut: false,
			unfillable: (error as Error).message,
		}
	}
	while (performance.now() - run.began < input.spec.timeoutMs) {
		const exchange = await pollOnce(input, method, path)
		run.exchanges.push(exchange)
		run.polls += 1
		const outcome = settledBy(input.spec, exchange, run)
		if (outcome !== undefined) return outcome
		await sleep(input.spec.pollIntervalMs)
	}
	return unfinished(run, "timed-out")
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms))
}

export { readPath }
