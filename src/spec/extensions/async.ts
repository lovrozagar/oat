/** `x-async` and `x-wait`: operations whose outcome arrives later, and how long to poll for it. */

import type { OperationObject } from "../types.ts"
import { extObject } from "./tag.ts"

export interface AsyncSpec {
	poll: string
	idFrom?: string
	until?: string
	successWhen?: string
	timeoutMs: number
	pollIntervalMs: number
}

export function readAsync(op: OperationObject): AsyncSpec | null {
	const tag = extObject<AsyncSpec>(op, "x-async")
	if (tag === undefined || typeof tag.poll !== "string") return null
	const spec: AsyncSpec = {
		poll: tag.poll,
		pollIntervalMs: typeof tag.pollIntervalMs === "number" ? tag.pollIntervalMs : 2000,
		timeoutMs: typeof tag.timeoutMs === "number" ? tag.timeoutMs : 120_000,
	}
	if (typeof tag.idFrom === "string") spec.idFrom = tag.idFrom
	if (typeof tag.until === "string") spec.until = tag.until
	if (typeof tag.successWhen === "string") spec.successWhen = tag.successWhen
	return spec
}

export interface WaitSpec {
	operationId: string
	until?: string
	timeoutMs: number
	pollIntervalMs: number
}

/**
 * `x-wait: { operationId, until?, timeoutMs? }` — after this write, poll `operationId` until
 * `until` (JSON path / pointer) is non-empty, or `hooks.awaitSideEffect` returns true.
 * Default timeout 30s. Timeout is a finding, not a coverage gap.
 */
export function readWait(op: OperationObject): WaitSpec | null {
	const tag = extObject<WaitSpec>(op, "x-wait")
	if (tag === undefined || typeof tag.operationId !== "string" || tag.operationId === "") return null
	const spec: WaitSpec = {
		operationId: tag.operationId,
		pollIntervalMs: typeof tag.pollIntervalMs === "number" && tag.pollIntervalMs > 0 ? tag.pollIntervalMs : 1000,
		timeoutMs: typeof tag.timeoutMs === "number" && tag.timeoutMs > 0 ? tag.timeoutMs : 30_000,
	}
	if (typeof tag.until === "string" && tag.until !== "") spec.until = tag.until
	return spec
}
