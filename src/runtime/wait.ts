/**
 * After a write, poll another operation until a JSON path is present or a hook says so.
 *
 * Queue consumers and webhook inboxes are not the same request. Timeout is a finding, not a
 * coverage gap — the document claimed the side effect would appear.
 */

import type { Hooks } from "../config/define-config.ts"
import type { WaitSpec } from "../spec/extensions.ts"
import type { OperationModel } from "../spec/graph.ts"
import type { Client, Exchange } from "./client.ts"
import { sleep } from "./poll.ts"
import { fillPath } from "./world.ts"

export function readPointer(body: unknown, pointer: string): unknown {
	if (pointer.startsWith("/")) return readJsonPointer(body, pointer)
	let node: unknown = body
	for (const segment of pointer
		.replace(/^\$\.?/, "")
		.split(".")
		.filter(Boolean)) {
		if (node === null || typeof node !== "object") return undefined
		const index = Number.parseInt(segment, 10)
		node = Array.isArray(node)
			? Number.isNaN(index)
				? undefined
				: node[index]
			: (node as Record<string, unknown>)[segment]
	}
	return node
}

function readJsonPointer(body: unknown, pointer: string): unknown {
	if (pointer === "/") return body
	let node: unknown = body
	for (const raw of pointer.slice(1).split("/")) {
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~")
		if (node === null || typeof node !== "object") return undefined
		const index = Number.parseInt(segment, 10)
		node = Array.isArray(node)
			? Number.isNaN(index)
				? undefined
				: node[index]
			: (node as Record<string, unknown>)[segment]
	}
	return node
}

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

export async function driveWait(options: {
	client: Client
	pollOp: OperationModel
	spec: WaitSpec
	scope: Record<string, string>
	headers: () => Record<string, string>
	writeOpId: string
	record: unknown
	awaitSideEffect?: Hooks["awaitSideEffect"]
	refreshIfStale?: (force?: boolean) => Promise<void>
}): Promise<WaitOutcome> {
	const exchanges: Exchange[] = []
	const began = performance.now()
	let polls = 0
	let path: string
	try {
		path = fillPath(options.pollOp.path, options.scope)
	} catch {
		return {
			elapsedMs: performance.now() - began,
			exchanges,
			matched: undefined,
			polls: 0,
			timedOut: true,
		}
	}

	while (performance.now() - began < options.spec.timeoutMs) {
		if (options.refreshIfStale !== undefined) await options.refreshIfStale()
		const exchange = await options.client.request(options.pollOp.method, path, {
			headers: options.headers,
			operationId: options.pollOp.operationId,
			...(options.refreshIfStale === undefined ? {} : { refreshIfStale: options.refreshIfStale }),
		})
		exchanges.push(exchange)
		polls += 1

		const body = exchange.status < 300 ? exchange.responseBody : undefined
		const untilHit = options.spec.until === undefined ? false : pointerIsOccupied(readPointer(body, options.spec.until))
		let hookHit = false
		if (options.awaitSideEffect !== undefined) {
			const verdict = await options.awaitSideEffect({
				attempt: polls,
				operationId: options.writeOpId,
				record: body ?? options.record,
			})
			hookHit = verdict === true
		}
		const matched = options.spec.until === undefined ? hookHit : untilHit || hookHit
		if (options.spec.until === undefined && options.awaitSideEffect === undefined) {
			if (exchange.status < 300 && pointerIsOccupied(body)) {
				return {
					elapsedMs: performance.now() - began,
					exchanges,
					matched: body,
					polls,
					timedOut: false,
				}
			}
		} else if (matched) {
			return {
				elapsedMs: performance.now() - began,
				exchanges,
				matched: options.spec.until === undefined ? body : readPointer(body, options.spec.until),
				polls,
				timedOut: false,
			}
		}

		const remaining = options.spec.timeoutMs - (performance.now() - began)
		if (remaining <= 0) break
		await sleep(Math.min(options.spec.pollIntervalMs, remaining))
	}

	return {
		elapsedMs: performance.now() - began,
		exchanges,
		matched: undefined,
		polls,
		timedOut: true,
	}
}
