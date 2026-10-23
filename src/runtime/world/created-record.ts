import type { Client } from "../../client/client.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { createdIdOf, createdRecordOf } from "../created-id.ts"
import type { Exchange } from "../exchange.ts"
import { confirmSubmitted } from "./confirm.ts"
import { answersRecord, type CreatedRecord, expectedFields, readBackCreated } from "./read-back.ts"
import { recordOf } from "./records.ts"

function jsonText(sent: unknown): unknown {
	if (typeof sent !== "string") return sent
	try {
		return JSON.parse(sent) as unknown
	} catch {
		return sent
	}
}

/**
 * The record a create made, carrying an id oat may delete by, or `null` when none can be read.
 *
 * An id the answer names by contract (a declared `createdIdFrom`, its own identity, or its
 * `Location`) stands. A candidate — the record under an envelope, an id key found deeper in the
 * answer — stands once a read under it shows what was sent; so does an id the client chose, for a
 * create that answers only an acknowledgement. `acknowledged` says the answer named no id at all.
 *
 * An answer under a trusted id that is not the record (`answersRecord`) is read back by that id
 * (`readBackCreated`), unless the caller `wants` only the id: a ledger needs nothing else.
 */
export async function createdRecord(input: {
	client: Pick<Client, "get">
	model: SpecModel
	createOp: OperationModel
	exchange: Exchange
	sent: unknown
	scope: Record<string, string>
	/** The principal that created it, which reads it back: `as: { principal }`. */
	principal: string
	readable?: (op: OperationModel) => boolean
	/** `"id"` when only the id matters: an answer that is not the record is then never read back. */
	wants?: "id"
}): Promise<CreatedRecord | null> {
	const { createOp, model } = input
	const entity = createOp.entity
	const identity = (entity === null ? undefined : model.entities.get(entity))?.identity ?? "id"
	const body = input.exchange.responseBody ?? {}
	/* A probe may send the body as JSON text under another media type: compare what it said. */
	const sent = jsonText(input.sent)
	/* A declared record path wins; without one, the envelope is inferred from what was sent. */
	const record = createOp.recordPath === null ? createdRecordOf(body, identity, sent) : (recordOf(createOp, body) ?? {})
	const resolved = createdIdOf({ createOp, exchange: input.exchange, model, sent })
	if (resolved?.trusted === true) {
		const answered = { ...record, [identity]: resolved.value }
		if (input.wants === "id" || answersRecord(answered, expectedFields(model, createOp, sent)))
			return { acknowledged: false, record: answered }
		return readBackCreated({ ...input, id: resolved, sent })
	}
	if (entity === null) return null
	const confirmed = await confirmSubmitted({
		client: input.client,
		entity,
		identity,
		model,
		principal: input.principal,
		scope: input.scope,
		sent,
		...(resolved === undefined ? {} : { id: resolved.id }),
		...(input.readable === undefined ? {} : { readable: input.readable }),
	})
	return confirmed === null ? null : { acknowledged: resolved === undefined, record: confirmed }
}
