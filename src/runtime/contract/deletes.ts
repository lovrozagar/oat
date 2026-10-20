/**
 * A delete that only answered 2xx has not been shown to delete anything. Read the same resource
 * once: 404 or 410 proves it, as does a soft-delete marker set on what comes back. A record that
 * is still readable, unmarked, was not deleted.
 */

import type { CheckId } from "../check-ids.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import type { PassEvidence } from "../grades.ts"
import type { ConfirmInput } from "./types.ts"

const DELETE_CHECK_ID = "delete.absent-record-returns-404" as const satisfies CheckId

/** A successful delete, the read on its path, and that path below the base URL. */
interface ReadBack {
	op: OperationModel
	call: Exchange
	read: OperationModel
	path: string
}

export async function confirmDeletes(input: ConfirmInput): Promise<void> {
	for (const op of input.model.operations) {
		if (input.stopped()) return
		const target = readBackOf(input, op)
		if (target === null) continue
		const after = await input.client.request("GET", target.path, {
			as: { principal: input.principal },
			operationId: target.read.operationId,
		})
		judgeReadBack(input, target, after)
	}
}

/** The delete to read back, or `null` when it is no delete, out of scope, proven already, or never answered 2xx. */
function readBackOf(input: ConfirmInput, op: OperationModel): ReadBack | null {
	const { grades, model } = input
	if (op.method.toUpperCase() !== "DELETE") return null
	if (input.mode === "targeted" && !input.inScope(op.operationId)) return null
	if (grades.evidence.get(op.operationId)?.observation !== undefined) return null
	const read = model.operations.find((other) => other.method.toUpperCase() === "GET" && other.path === op.path)
	if (read === undefined) return null
	const call = input.client.transcript.findLast(
		(exchange) => exchange.operationId === op.operationId && exchange.status >= 200 && exchange.status < 300,
	)
	if (call === undefined) return null
	try {
		/* Below the base URL, as the client takes it: under a mount like `/api` the full path
		 * would be prefixed a second time and answer 404 for a record that is still there. */
		return { call, op, path: input.client.relativePath(call.url), read }
	} catch {
		return null
	}
}

function judgeReadBack(input: ConfirmInput, target: ReadBack, after: Exchange): void {
	const { grades } = input
	const { call, op, path, read } = target
	if (after.status === 404 || after.status === 410) {
		grades.graded([op.operationId], DELETE_CHECK_ID)
		grades.prove(op.operationId, { call: call.seq, observation: { seq: after.seq, status: after.status } })
		return
	}
	if (after.status < 200 || after.status >= 300) {
		/* A refused read (the caller's session ended, a role it lost) shows nothing about the
		 * record. Say so: going quiet would pass a delete nobody saw through. */
		input.findings
			.attributed([op.operationId])
			.ownedBy(DELETE_CHECK_ID)
			.unresolved(
				DELETE_CHECK_ID,
				op.entity ?? op.operationId,
				`${read.operationId} answered ${after.status} when reading ${path} back after ${op.operationId}, so whether the record is gone was not seen`,
			)
		return
	}
	grades.graded([op.operationId], DELETE_CHECK_ID)
	const observation = emptied(read, after) ?? marked(op, read, after)
	if (observation !== undefined) {
		grades.prove(op.operationId, { call: call.seq, observation })
		return
	}
	input.findings
		.attributed([op.operationId])
		.ownedBy(DELETE_CHECK_ID)
		.backend(DELETE_CHECK_ID, op.entity ?? op.operationId, {
			summary: "a deleted record is still readable",
			detail: `${op.operationId} returned ${call.status}, and ${read.operationId} on the same path then returned ${after.status} with no deletion marker.`,
			evidence: [call, after],
		})
}

/**
 * A delete of the whole collection has no item to read back: the read on its path is the list,
 * and the empty list it leaves is the proof.
 */
function emptied(read: OperationModel, after: Exchange): PassEvidence["observation"] {
	if (read.collection === null) return undefined
	const key = read.collection.key
	const listed = key === null ? after.responseBody : (after.responseBody as Record<string, unknown> | null)?.[key]
	if (!Array.isArray(listed) || listed.length > 0) return undefined
	return { path: key === null ? "$" : `$.${key}`, seq: after.seq, value: "[]" }
}

/** A soft-delete marker set on what the read returned. */
function marked(op: OperationModel, read: OperationModel, after: Exchange): PassEvidence["observation"] {
	const marker = op.softDelete ?? read.softDelete
	if (marker === null) return undefined
	const value = (after.responseBody as Record<string, unknown> | null)?.[marker]
	if (value === undefined || value === null) return undefined
	return { path: `$.${marker}`, seq: after.seq, value: String(value) }
}
