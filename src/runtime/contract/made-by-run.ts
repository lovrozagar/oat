/*
 * The run's own evidence that it made a record: the ledger, which holds every create the run saw
 * answer (inferred ones included), and the credential store's own creates, which the ledger leaves
 * out because a minted key is a credential, never teardown's to remove. An id an answer merely
 * showed is no such evidence: a list or a read echoes records the run did not make.
 *
 * A credential the store minted is the floor's to write to only when nothing still relies on it: it
 * was revoked or deleted already, or it is a dedicated credential a probe principal holds, the
 * store's to burn. A principal's live key or session never is: a write could end the very session
 * the run acts as. One the store no longer holds at all is no one's to judge, so it is left alone.
 */

import { isProbePrincipal } from "../../credentials/probe-principal.ts"
import type { HeldCredential } from "../../credentials/store-types.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import { returnedId } from "../proven-id.ts"
import type { Ledger } from "../teardown/ledger.ts"

/** Where the evidence is: the ledger, the transcript, the credentials the store holds, and the model. */
export interface RunEvidence {
	client: { transcript: readonly Exchange[] }
	/** Every credential the store holds as the floor starts, a principal's or a probe principal's. */
	held: readonly HeldCredential[]
	ledger: Pick<Ledger, "holds">
	model: SpecModel
}

/* One record asked about, and the credential values the store may burn. */
interface Asked {
	entity: string
	id: string
	burnable: ReadonlySet<string>
}

/** Whether this run made the record of `entity` with `id` and may write to it, removed since or not. */
export function madeByRun(evidence: RunEvidence): (entity: string, id: string) => boolean {
	const probes = evidence.held.filter((entry) => isProbePrincipal(entry.principal))
	const burnable = new Set(probes.map((entry) => entry.credential.value))
	return (entity, id) => evidence.ledger.holds(entity, id) || issued(evidence, { burnable, entity, id })
}

/* The credential store's own create of the record answered it, and nothing relies on it any more. */
function issued(evidence: RunEvidence, asked: Asked): boolean {
	const { client, model } = evidence
	const identity = model.entities.get(asked.entity)?.identity ?? "id"
	const mint = client.transcript.find((exchange) => {
		if (exchange.issuedBy !== "credentials" || !succeeded(exchange)) return false
		if (entityOf(model, exchange) !== asked.entity) return false
		const body = exchange.responseBody
		return (
			typeof body === "object" && body !== null && returnedId(body as Record<string, unknown>, identity) === asked.id
		)
	})
	if (mint === undefined) return false
	return revoked(evidence, asked) || holdsAny(mint.responseBody, asked.burnable)
}

/* A successful DELETE of the record: it was revoked or removed already. */
function revoked({ client, model }: RunEvidence, asked: Asked): boolean {
	return client.transcript.some(
		(exchange) =>
			exchange.method === "DELETE" &&
			succeeded(exchange) &&
			entityOf(model, exchange) === asked.entity &&
			decodeURIComponent(new URL(exchange.url).pathname.split("/").at(-1) as string) === asked.id,
	)
}

/* Whether any string in the answer is one of `values`: the credential the mint answered with. */
function holdsAny(node: unknown, values: ReadonlySet<string>): boolean {
	if (typeof node === "string") return values.has(node)
	if (node === null || typeof node !== "object") return false
	return Object.values(node).some((value) => holdsAny(value, values))
}

const succeeded = (exchange: Exchange): boolean => exchange.status >= 200 && exchange.status < 300

const entityOf = (model: SpecModel, exchange: Exchange): string | null | undefined =>
	model.byOperationId.get(exchange.operationId ?? "")?.entity
