/**
 * A hook that sees every request before it leaves the process and may refuse it.
 *
 * A refused request never reaches the backend, so nothing about it can be a verdict on the
 * backend: it surfaces as `FencedError` on the path the caller already treats as "could not
 * finish" — a check unresolved, a cohort blocked, a teardown leftover — never as a response a
 * check could read a status from. Every refusal is kept, so the report can list them all.
 */

import type { FenceDecision, FenceRequest } from "../config/types/hooks.ts"

export interface FencedRequest {
	method: string
	url: string
	operationId?: string
	phase: string
	reason: string
}

export class FencedError extends Error {
	override name = "FencedError"
	constructor(readonly request: FencedRequest) {
		super(`fenced: ${request.reason} (${request.method} ${request.url})`)
	}
}

export class Fence {
	readonly fenced: FencedRequest[] = []

	constructor(private readonly hook: (request: FenceRequest) => FenceDecision | Promise<FenceDecision>) {}

	/** Resolves when the request may go; throws `FencedError`, after recording it, when it may not. */
	async check(request: FenceRequest): Promise<void> {
		const decision = await this.hook(request)
		if (decision.allow) return
		const refused: FencedRequest = {
			method: request.method,
			phase: request.phase,
			reason: decision.reason,
			url: request.url,
			...(request.operationId === undefined ? {} : { operationId: request.operationId }),
		}
		this.fenced.push(refused)
		throw new FencedError(refused)
	}
}
