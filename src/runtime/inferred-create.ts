/**
 * A record made by a POST that is not its entity's create: an untagged document files `job.start`
 * under job as an action, yet its answer names the job it started. Nothing declared it, so it is
 * ledgered only on evidence: the answer names a new `<entity>_id`, and a read of that id answers
 * 2xx as the principal that sent the POST. The record is marked inferred.
 */

import { UnsatisfiedSecurity } from "../client/credential-source.ts"
import type { Client } from "../client/client.ts"
import { isNetworkError } from "../errors/network.ts"
import type { EntityModel, OperationModel, SpecModel } from "../spec/graph/types.ts"
import type { Exchange } from "./exchange.ts"
import { FencedError } from "./fence.ts"
import { createdId } from "./proven-id.ts"
import { SELF_IDENTITY } from "./self/operations.ts"
import type { Ledger } from "./teardown/ledger.ts"
import { readPathOf } from "./teardown/routes.ts"
import type { Created } from "./teardown/types.ts"

/** What an inference reads against: the model, the run's ledger, and the client that sent the POST. */
export interface InferenceInput {
	model: SpecModel
	ledger: Ledger
	client: Client
	readable: (op: OperationModel) => boolean
}

/** The POST as the tracker read it: its operation, the parameters its path gave, and the sender. */
export interface Posted {
	exchange: Exchange
	op: OperationModel
	params: Record<string, string>
	sender: { principal: string; roots: Record<string, string> }
}

/** The record a POST made, when every condition holds; otherwise `undefined`, and nothing is ledgered. */
export async function inferredCreate(input: InferenceInput, posted: Posted): Promise<Created | undefined> {
	const named = namedRecord(input.model, posted)
	if (named === undefined) return undefined
	const { entity, id } = named
	if (input.ledger.holds(entity.name, id) || (await mentioned(input.client, posted.exchange, id))) return undefined
	const created: Created = {
		entity: entity.name,
		id,
		inferred: true,
		scope: { ...posted.sender.roots, ...posted.params },
	}
	return (await readsBack(input, created, posted.sender.principal)) ? created : undefined
}

/* The entity and id a POST's answer names, when the POST could have made that record. */
function namedRecord(model: SpecModel, posted: Posted): { entity: EntityModel; id: Created["id"] } | undefined {
	const entity = makerOf(model, posted)
	const id = entity === undefined ? undefined : answeredId(posted.exchange.responseBody, `${entity.name}_id`)
	return entity === undefined || id === undefined ? undefined : { entity, id }
}

/*
 * The entity a POST could have made a record of: the one it is filed under, whose create it is not,
 * with no declared effect, and a path that names no record of that entity.
 */
function makerOf(model: SpecModel, { exchange, op }: Posted): EntityModel | undefined {
	const entity = op.entity === null ? undefined : model.entities.get(op.entity)
	if (exchange.method !== "POST" || entity === undefined || entity.create === op.operationId) return undefined
	if (entity.identity === SELF_IDENTITY || op.effects.length > 0 || op.async !== null) return undefined
	const read = entity.read === undefined ? undefined : model.byOperationId.get(entity.read)
	const item = read?.pathParams.at(-1)
	return item === undefined || op.pathParams.includes(item) ? undefined : entity
}

/* The non-empty string an object answer holds at `key`. */
function answeredId(answer: unknown, key: string): Created["id"] | undefined {
	if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return undefined
	const value = (answer as Record<string, unknown>)[key]
	return typeof value === "string" && value !== "" ? createdId(value) : undefined
}

/* Whether `id` appeared before the POST answered it: in its own request, or in any earlier exchange. */
async function mentioned(client: Client, exchange: Exchange, id: string): Promise<boolean> {
	if (names(exchange.url, exchange.requestBody, id)) return true
	for (const earlier of client.transcript) {
		if (earlier.seq >= exchange.seq) continue
		const whole = await client.hydrate(earlier)
		if (names(whole.url, whole.requestBody, id) || holdsValue(whole.responseBody, id)) return true
	}
	return false
}

/* A URL that has `id` as a path segment or query value, or a body that holds it. */
function names(url: string, body: unknown, id: string): boolean {
	const parsed = new URL(url)
	const segments = parsed.pathname.split("/").map((segment) => decodeURIComponent(segment))
	return segments.includes(id) || [...parsed.searchParams.values()].includes(id) || holdsValue(body, id)
}

/* Whether `id` is a string anywhere in `value`. */
function holdsValue(value: unknown, id: string): boolean {
	if (value === id) return true
	if (typeof value !== "object" || value === null) return false
	return Object.values(value).some((inner) => holdsValue(inner, id))
}

/* One read of the record as the principal that sent the POST; only a 2xx shows the record exists. */
async function readsBack(input: InferenceInput, created: Created, principal: string): Promise<boolean> {
	const read = readPathOf(input.model, { ...created, owner: { id: principal } })
	if (read === null || !input.readable(read.op)) return false
	try {
		const client = input.client.view({ purpose: "assertion", subject: created.entity })
		const exchange = await client.get(read.path, { as: { principal }, operationId: read.op.operationId })
		return exchange.status >= 200 && exchange.status < 300
	} catch (error) {
		if (error instanceof FencedError || error instanceof UnsatisfiedSecurity || isNetworkError(error)) return false
		throw error
	}
}
