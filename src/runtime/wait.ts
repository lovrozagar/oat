/**
 * After a write, poll another operation until a JSON path is present or a hook says so.
 *
 * Queue consumers and webhook inboxes are not the same request. Timeout is a finding, not a
 * coverage gap — the document claimed the side effect would appear.
 */

import type { Hooks } from "../config/types/hooks.ts"
import type { WaitSpec } from "../spec/extensions/async.ts"
import type { OperationModel } from "../spec/graph/types.ts"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import { readPath as readPointer } from "../client/read-path.ts"
import { sleep } from "./poll.ts"
import { fillPath } from "./fill-path.ts"

/** Present enough to stop polling: not null, not "", not []. */
export function pointerIsOccupied(value: unknown): boolean {
	if (value === undefined || value === null || value === "") return false
	if (Array.isArray(value) && value.length === 0) return false
	return true
}

export interface WaitOutcome {
	timedOut: boolean
	polls: number
	elapsedMs: number
	exchanges: Exchange[]
	matched: unknown
}

/** What waiting on a side effect needs: the write that should cause it, and where it shows up. */
export interface WaitDrive {
	client: Client
	pollOp: OperationModel
	spec: WaitSpec
	scope: Record<string, string>
	headers: () => Record<string, string>
	writeOpId: string
	record: unknown
	awaitSideEffect?: Hooks["awaitSideEffect"]
	refreshIfStale?: (force?: boolean) => Promise<void>
}

/** The polls so far, and when waiting began. */
interface Waiting {
	began: number
	exchanges: Exchange[]
	polls: number
}

/** A poll that showed the side effect, with what it matched. */
interface Seen {
	matched: unknown
}

function waited(run: Waiting, seen: Seen | undefined): WaitOutcome {
	return {
		elapsedMs: performance.now() - run.began,
		exchanges: run.exchanges,
		matched: seen?.matched,
		polls: run.polls,
		timedOut: seen === undefined,
	}
}

async function pollOnce(options: WaitDrive, path: string): Promise<Exchange> {
	if (options.refreshIfStale !== undefined) await options.refreshIfStale()
	return options.client.request(options.pollOp.method, path, {
		headers: options.headers,
		operationId: options.pollOp.operationId,
		...(options.refreshIfStale === undefined ? {} : { refreshIfStale: options.refreshIfStale }),
	})
}

/** Whether the hook says the side effect has happened, asked on every poll when there is one. */
async function hookSaw(options: WaitDrive, body: unknown, attempt: number): Promise<boolean> {
	if (options.awaitSideEffect === undefined) return false
	const verdict = await options.awaitSideEffect({
		attempt,
		operationId: options.writeOpId,
		record: body ?? options.record,
	})
	return verdict === true
}

/**
 * Whether one poll showed the side effect: `until` occupied or the hook saying so, or, with
 * neither declared, any occupied success body.
 */
async function sawEffect(options: WaitDrive, exchange: Exchange, attempt: number): Promise<Seen | undefined> {
	const body = exchange.status < 300 ? exchange.responseBody : undefined
	const { until } = options.spec
	if (until === undefined && options.awaitSideEffect === undefined) {
		return pointerIsOccupied(body) ? { matched: body } : undefined
	}
	const hookHit = await hookSaw(options, body, attempt)
	if (until === undefined) return hookHit ? { matched: body } : undefined
	const found = readPointer(body, until)
	return pointerIsOccupied(found) || hookHit ? { matched: found } : undefined
}

export async function driveWait(options: WaitDrive): Promise<WaitOutcome> {
	const run: Waiting = { began: performance.now(), exchanges: [], polls: 0 }
	let path: string
	try {
		path = fillPath(options.pollOp.path, options.scope)
	} catch {
		return waited(run, undefined)
	}
	while (performance.now() - run.began < options.spec.timeoutMs) {
		const exchange = await pollOnce(options, path)
		run.exchanges.push(exchange)
		run.polls += 1
		const seen = await sawEffect(options, exchange, run.polls)
		if (seen !== undefined) return waited(run, seen)
		const remaining = options.spec.timeoutMs - (performance.now() - run.began)
		if (remaining <= 0) break
		await sleep(Math.min(options.spec.pollIntervalMs, remaining))
	}
	return waited(run, undefined)
}

export { readPointer }
