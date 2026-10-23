/*
 * A create whose body names a client-chosen identity. The identity is drawn so no record the run
 * knows of holds it, and reserved before the request goes out. Another tenant's record can still hold
 * it, in an id space that spans tenants, and the create answers 409: the refused identity joins the
 * taken set, so no later draw reuses it, and the create is sent again under a fresh one. Three
 * attempts in all; after the third refusal, or when no fresh identity is left, the create stops with
 * the reason, and sends nothing more.
 * The seed cohort, ancestors and checks' own creates all create this way.
 */

import { messageOf } from "../../errors/message.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import type { Exchange } from "../exchange.ts"
import { SeedError } from "../seed-error.ts"
import { uniquifyProbeBody } from "../unique.ts"
import { idOf } from "./records.ts"
import type { WorldOptions } from "./types.ts"
import type { JsonSchema } from "../../spec/types.ts"

/** Attempts a create with a client-chosen identity makes before its 409 is the answer. */
export const CLIENT_ID_ATTEMPTS = 3

/* How many identities one draw tries before it gives up on finding one no record holds. */
const DRAWS = 16

/** How a create's client-chosen identity is drawn. */
export interface ClientIdentity {
	/** The property that holds the identity; `null` when the body names none of its own. */
	identity: string | null
	schema: JsonSchema
	/** The identities the run's records hold, or that it reserved or had refused: no draw takes one. */
	taken: Set<string>
	/** Sets this create's draws apart from every other's. */
	token: string
}

/** What a create with a client-chosen identity came to: the last answer, its body, and why it stopped. */
export interface ClientIdCreate {
	exchange: Exchange
	sent: Record<string, unknown>
	/** Set when every attempt was refused with 409: the reason, naming the identities refused. */
	exhausted?: string
}

/** A seed's failure when every identity its create drew was refused: no record, adopted or made, and why. */
export function identitiesRefused(operationId: string, exchange: Exchange, exhausted: string): SeedError {
	return new SeedError(operationId, `${operationId}: ${exhausted}`, { exchange, operationId, status: exchange.status })
}

/** The run's taken identities for `createOp`'s entity, or a set of the create's own when it has none to share. */
export function takenFor(options: Pick<WorldOptions, "taken">, createOp: OperationModel): Set<string> {
	return options.taken === undefined || createOp.entity === null ? new Set() : options.taken(createOp.entity)
}

/** The identity `createOp`'s body names of its own entity's, when its schema has the property; else `null`. */
export function bodyIdentity(model: SpecModel, createOp: OperationModel, schema: JsonSchema): string | null {
	const identity = model.entities.get(createOp.entity ?? "")?.identity ?? null
	const properties = (schema.properties ?? {}) as Record<string, unknown>
	return identity !== null && Object.hasOwn(properties, identity) ? identity : null
}

/**
 * The body with an identity no taken record holds, reserved now, before the request goes out, so a
 * body made meanwhile picks another. A body that names no identity comes back as it is.
 */
export function reserveIdentity(body: Record<string, unknown>, at: ClientIdentity): Record<string, unknown> {
	const { identity, schema, taken, token } = at
	if (identity === null || idOf(body, identity) === undefined) return body
	let reserved = body
	const held = (): boolean => taken.has(idOf(reserved, identity) as string)
	for (let draw = 0; draw < DRAWS && held(); draw++) {
		reserved = uniquifyProbeBody(reserved, [[identity]], { schema, token: `${token}t${draw}` })
	}
	if (held()) throw new Error(`no "${identity}" is left that names no existing record`)
	taken.add(idOf(reserved, identity) as string)
	return reserved
}

/**
 * Sends `body` with `send`. A 409 to a body naming its own identity is taken as that identity being
 * held elsewhere: it joins the taken set and the create goes again under a fresh one, up to
 * `CLIENT_ID_ATTEMPTS` in all. A 409 to a body that names none is the answer.
 */
export async function createWithClientId(
	body: Record<string, unknown>,
	send: (body: Record<string, unknown>) => Promise<Exchange>,
	at: ClientIdentity,
): Promise<ClientIdCreate> {
	const refused: string[] = []
	const stopped = (why: string): string =>
		`every client-chosen "${at.identity}" sent was refused with 409 (${refused.join(", ")}); ${why}`
	let sent = body
	for (let attempt = 1; ; attempt++) {
		const exchange = await send(sent)
		const id = at.identity === null ? undefined : idOf(sent, at.identity)
		if (exchange.status !== 409 || id === undefined) return { exchange, sent }
		at.taken.add(id)
		refused.push(id)
		if (attempt >= CLIENT_ID_ATTEMPTS) return { exchange, exhausted: stopped("no fourth create was sent"), sent }
		try {
			sent = reserveIdentity(sent, { ...at, token: `${at.token}r${attempt}` })
		} catch (error) {
			/* The schema admits no identity the run has not seen taken: nothing fresh is left to send. */
			return { exchange, exhausted: stopped(messageOf(error)), sent }
		}
	}
}
