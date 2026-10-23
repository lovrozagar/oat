/**
 * What a document declares that oat never exercises: webhooks the API sends, callbacks it makes,
 * links to follow-up calls, and OAS 3.2 `additionalOperations`. Each becomes a gap `doctor` names,
 * so a silent skip never reads as coverage.
 */

import { listEndpoints } from "../endpoints.ts"
import type { GapCollector } from "../extensions/gaps.ts"
import type { OpenApiDocument } from "../types.ts"
import type { OperationModel } from "./types.ts"

/* The keys of a map the document declares; anything that is not a map declares none. */
function keysOf(value: unknown): string[] {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []
}

/* One member of an untyped object, or undefined when there is no object to read. */
function member(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined
}

function recordCallsOut(doc: OpenApiDocument, gaps: GapCollector): void {
	for (const { op, operationId } of listEndpoints(doc)) {
		for (const name of keysOf(member(op, "callbacks"))) {
			gaps.record(
				operationId,
				"callbacks",
				`declares callback "${name}", a call the API makes back to a URL the request names`,
			)
		}
		const responses = member(op, "responses")
		for (const status of keysOf(responses)) {
			for (const name of keysOf(member(member(responses, status), "links"))) {
				gaps.record(operationId, "links", `response ${status} links "${name}" to a follow-up call oat does not make`)
			}
		}
	}
}

/* OAS 3.2 methods outside the fixed Path Item fields, keyed as they are sent. */
function recordAdditionalOperations(doc: OpenApiDocument, gaps: GapCollector): void {
	for (const [path, item] of Object.entries(doc.paths ?? {})) {
		const additional = member(item, "additionalOperations")
		for (const method of keysOf(additional)) {
			const id = member(member(additional, method), "operationId")
			gaps.record(
				typeof id === "string" ? id : `${method} ${path}`,
				"additionalOperations",
				`declares method ${method} under additionalOperations, which oat does not send`,
			)
		}
	}
}

/**
 * An operation oat lists but never sends (TRACE) is a gap under its method, and joins no entity: no
 * lifecycle may pick it as a read or a write it would then fail to send.
 */
export function recordUnsendable(operations: readonly OperationModel[], gaps: GapCollector): void {
	for (const op of operations) {
		if (op.unsendable === null) continue
		gaps.record(op.operationId, op.method, op.unsendable)
		leaveUntested(op, op.unsendable)
	}
}

/** Marks `op` never sent, for `reason`, and takes it out of every lifecycle. */
export function leaveUntested(op: OperationModel, reason: string): void {
	op.unsendable = reason
	op.entity = null
	op.entitySource = null
	op.action = null
}

/** Records a gap for every webhook, callback, response link and additional operation the document declares. */
export function recordUnmodelled(doc: OpenApiDocument, gaps: GapCollector): void {
	for (const name of keysOf(member(doc, "webhooks"))) {
		gaps.record(
			`webhook ${name}`,
			"webhooks",
			"is a call the API sends to a subscriber's URL; oat receives no inbound call",
		)
	}
	recordCallsOut(doc, gaps)
	recordAdditionalOperations(doc, gaps)
}
