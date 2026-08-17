/**
 * Async operation support.
 *
 * `x-async` means the HTTP response is a receipt, then oat polls. A `text/event-stream` body is
 * the result itself — parse events, do not `JSON.parse` the raw string. Poll only when the
 * stream ends without a terminal frame and `idFrom` resolved.
 */

import type { AsyncSpec } from "../spec/extensions.ts"
import type { Client, Exchange } from "./client.ts"
import { type SseEvent, sseEvents } from "./sse.ts"
import { fillPath } from "./world.ts"

export interface AsyncOutcome {
	/** Terminal state reached, or null on timeout. */
	terminal: Record<string, unknown> | null
	exchanges: Exchange[]
	polls: number
	elapsedMs: number
	timedOut: boolean
	/** True when `successWhen` matched; false when a terminal-but-failed state was reached. */
	succeeded: boolean
}

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

export function readPath(body: unknown, path: string): unknown {
	let node: unknown = body
	for (const segment of path
		.replace(/^\$\.?/, "")
		.split(".")
		.filter(Boolean)) {
		if (node === null || typeof node !== "object") return undefined
		node = (node as Record<string, unknown>)[segment]
	}
	return node
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

/**
 * Polls until `until` matches, the timeout expires, or the poll route stops responding.
 *
 * Polling is capped by wall-clock rather than attempt count so a slow backend and a fast one
 * behave the same way, and the interval is fixed rather than exponential — the point is to
 * observe when the state changes, not to be gentle with an API oat is already hammering.
 */
export async function driveAsync(
	client: Client,
	spec: AsyncSpec,
	receipt: unknown,
	scope: Record<string, string>,
	headers: () => Record<string, string>,
	refreshIfStale?: (force?: boolean) => Promise<void>,
): Promise<AsyncOutcome> {
	const exchanges: Exchange[] = []
	const began = performance.now()

	const pollScope = { ...scope }
	if (spec.idFrom !== undefined) {
		const id = resolveAsyncId(receipt, spec.idFrom)
		if (id !== undefined && id !== null) {
			/* The receipt names the job; bind it to whichever poll-path parameter is unresolved. */
			const parameters = [...spec.poll.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] ?? "")
			const unbound = parameters.find((name) => pollScope[name] === undefined)
			const target = unbound ?? spec.idFrom.replace(/^\$\./, "")
			pollScope[target] = String(id)
		}
	}

	const [method = "GET", template = spec.poll] = spec.poll.split(" ")
	let path: string
	try {
		path = fillPath(template, pollScope)
	} catch {
		return {
			elapsedMs: performance.now() - began,
			exchanges,
			polls: 0,
			succeeded: false,
			terminal: null,
			timedOut: false,
		}
	}

	let polls = 0
	while (performance.now() - began < spec.timeoutMs) {
		/* Live headers + countdown refresh per poll: a long POST can outlive remaining TTL,
		 * and a snapshot taken before the loop would keep sending the dead Bearer. */
		if (refreshIfStale !== undefined) await refreshIfStale()
		const exchange = await client.request(method, path, {
			headers,
			...(refreshIfStale === undefined ? {} : { refreshIfStale }),
		})
		exchanges.push(exchange)
		polls += 1

		if (exchange.status < 300) {
			const body = exchange.responseBody
			if (body !== null && typeof body === "object") {
				const record = body as Record<string, unknown>
				const done = spec.until === undefined || matchesPredicate(record, spec.until)
				if (done) {
					return {
						elapsedMs: performance.now() - began,
						exchanges,
						polls,
						succeeded: spec.successWhen === undefined || matchesPredicate(record, spec.successWhen),
						terminal: record,
						timedOut: false,
					}
				}
			}
		} else if (exchange.status === 404 && polls > 1) {
			/* The job existed and then did not — a vanished job is terminal, and reporting it as a
			 * timeout would name the wrong problem. */
			break
		}

		await sleep(spec.pollIntervalMs)
	}

	return {
		elapsedMs: performance.now() - began,
		exchanges,
		polls,
		succeeded: false,
		terminal: null,
		timedOut: true,
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms))
}
