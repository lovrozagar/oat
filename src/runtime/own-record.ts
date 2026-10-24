/*
 * A write to the principal's own record never changes how it signs in. The record is its own when
 * the operation is the self-identity resource (`x-entity.identity: self`), when an update or removal
 * names no record at all (`PUT /users/me`: the caller is the record), or when a path value is one of
 * its identity values (its own user id). There, a field is protected when its name is a credential's
 * (`password`, `api_key`) or one its sign-in reads (`email` where the login sends
 * `{principal.email}`, and the field it sends it under). A run that changed one would lock the
 * principal out of every later run.
 */

import type { Client } from "../client/client.ts"
import type { RequestOptions } from "../client/types.ts"
import { probeOwner } from "../credentials/probe-principal.ts"
import { isSecretJsonKey } from "../security/credential-names.ts"
import { operationResolver } from "../spec/graph/resolver.ts"
import type { OperationModel, SpecModel } from "../spec/graph/types.ts"
import { SAFE } from "../spec/methods.ts"
import { type CredentialRecord, heldCredential } from "./credential-records.ts"
import type { Exchange } from "./exchange.ts"
import { SELF_IDENTITY } from "./self/operations.ts"

/** What the run knows to guard its principals' own records with. */
export interface OwnRecords {
	/** Every identity key a principal's sign-in reads, and each field it sends one under (`signInFields`). */
	signIn: ReadonlySet<string>
	/**
	 * The identity of the configured principal `principal` sends for, a probe principal's its owner's;
	 * `undefined` for one the run signed up to throw away, whose record it may change.
	 */
	identityOf: (principal: string) => Readonly<Record<string, unknown>> | undefined
	/** A principal the run signs up to throw away, once: what a write that needs a protected field is sent as. */
	disposable: () => Promise<string | { blocked: string }>
	/** Takes what the principal's self read answered: its own ids, which no config names, join its identity. */
	learn?: (principal: string, answer: unknown) => void
	/** Every record holding a live credential the run depends on, every principal's (`mintedRecords`). */
	credentials?: () => readonly CredentialRecord[]
}

/*
 * The fields of a self read that name the caller's own record: its id, or its login name. A foreign
 * key (`project_id`, `org_id`) names another record, the tenant the caller belongs to, never its own.
 */
const IDENTIFIER = /^(id|uuid|guid|username|login|handle|user_?id|userId|account_?id|accountId)$/

/**
 * `base`, learning as the run goes: a self read's identifiers join the identity of the configured
 * principal that read it, so a write to `/users/<its own id>` is guarded though the config named only
 * how it signs in.
 */
export function ownRecordsFrom(base: Omit<OwnRecords, "learn">): OwnRecords {
	const learned = new Map<string, Record<string, unknown>>()
	return {
		...base,
		identityOf: (principal) => {
			const configured = base.identityOf(principal)
			return configured === undefined ? undefined : { ...configured, ...learned.get(probeOwner(principal)) }
		},
		learn: (principal, answer) => {
			if (base.identityOf(principal) === undefined || !isPlain(answer)) return
			const ids = Object.entries(answer).filter(([key, value]) => IDENTIFIER.test(key) && scalarText(value).length > 0)
			const owner = probeOwner(principal)
			learned.set(owner, { ...learned.get(owner), ...Object.fromEntries(ids) })
		},
	}
}

/** A write refused before it was sent: it would change how a principal signs in. Its message names the fields. */
export class ProtectedWriteError extends Error {
	override name = "ProtectedWriteError"
}

/**
 * A write that names a record the run depends on: a credential it holds, or a configured principal's
 * own record it would remove or replace. The check that sent it stands down, naming the record.
 */
export class HeldRecordError extends ProtectedWriteError {
	override name = "HeldRecordError"
}

/** Why `operationId` is not sent as `principal`'s with `fields`: the reason a stand-down gives. */
export function protectedReason(operationId: string, principal: string, fields: readonly string[]): string {
	const owner = probeOwner(principal)
	return `${operationId} would change ${fields.join(", ")} on ${owner}'s own record, which ${owner} signs in with: oat never sends that`
}

/** A write about to be sent: its operation, the path values it fills, and the identity of who sends it. */
export interface Write {
	op: Pick<OperationModel, "identity" | "method" | "pathParams">
	path: Readonly<Record<string, string>>
	identity: Readonly<Record<string, unknown>>
}

/** Whether `write` changes the principal's own record. */
export function ownRecord(write: Write): boolean {
	const { op } = write
	const method = op.method.toUpperCase()
	if (SAFE.has(method)) return false
	if (op.identity === SELF_IDENTITY) return true
	/* A create names no record either: it makes one. */
	if (op.pathParams.length === 0) return method !== "POST"
	const own = new Set(Object.values(write.identity).flatMap(scalarText))
	return Object.values(write.path).some((value) => own.has(value))
}

/**
 * The fields of `names` a write must not send: on the principal's own record, every
 * credential-named one and every one `signIn` lists (case aside); on any other record, none.
 */
export function protectedFields(signIn: ReadonlySet<string>, write: Write, names: Iterable<string>): Set<string> {
	if (!ownRecord(write)) return new Set()
	const lowered = new Set([...signIn].map((name) => name.toLowerCase()))
	return new Set([...names].filter((name) => isSecretJsonKey(name) || lowered.has(name.toLowerCase())))
}

/** A body a write may send, and the protected fields left out of it, by dotted path; or the ones it cannot go without. */
export type Guarded = { body: unknown; dropped: string[] } | { needs: string[] }

/**
 * The body without the fields `protectedFields` names, deep through plain objects. A field the
 * schema requires at its level is one the write needs: then nothing is dropped, and the caller
 * sends it as a disposable principal or stands down, naming it.
 */
export function guardWrite(
	signIn: ReadonlySet<string>,
	write: Write,
	sent: { body: unknown; schema?: unknown },
): Guarded {
	if (!isPlain(sent.body)) return { body: sent.body, dropped: [] }
	const fields = protectedFields(signIn, write, keysOf(sent.body))
	const dropped: string[] = []
	const needs: string[] = []
	const body = without(sent.body, { at: [], dropped, fields, needs, schema: sent.schema })
	return needs.length > 0 ? { needs } : { body, dropped }
}

interface Walk {
	at: string[]
	fields: ReadonlySet<string>
	schema: unknown
	dropped: string[]
	needs: string[]
}

function without(body: Record<string, unknown>, walk: Walk): Record<string, unknown> {
	const schema = isPlain(walk.schema) ? walk.schema : {}
	const required = Array.isArray(schema["required"]) ? (schema["required"] as unknown[]) : []
	const properties = isPlain(schema["properties"]) ? schema["properties"] : {}
	const kept: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(body)) {
		const at = [...walk.at, key]
		if (walk.fields.has(key)) (required.includes(key) ? walk.needs : walk.dropped).push(at.join("."))
		else kept[key] = isPlain(value) ? without(value, { ...walk, at, schema: properties[key] }) : value
	}
	return kept
}

/* Every key of a body, deep through plain objects. */
function keysOf(body: Record<string, unknown>): string[] {
	return Object.entries(body).flatMap(([key, value]) => [key, ...(isPlain(value) ? keysOf(value) : [])])
}

function isPlain(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function scalarText(value: unknown): string[] {
	return typeof value === "string" || typeof value === "number" ? [String(value)] : []
}

/** Throws for a request the guard never sends: one naming a held record, or one changing a protected field. */
function refuse(
	records: OwnRecords,
	write: { identity: Readonly<Record<string, unknown>> | undefined; op: OperationModel; path: Record<string, string> },
	sent: { body: unknown; method: string; principal: string | undefined },
): void {
	if (!SAFE.has(sent.method.toUpperCase())) refuseHeld(records, write, sent)
	const { identity, op } = write
	if (identity === undefined || !isPlain(sent.body)) return
	/* Deep, as guardWrite drops: `{ user: { password } }` changes the password as surely as `{ password }`. */
	const fields = [...protectedFields(records.signIn, { ...write, identity }, keysOf(sent.body))]
	if (fields.length > 0)
		throw new ProtectedWriteError(protectedReason(op.operationId, sent.principal as string, fields))
}

/*
 * A write the run must never send, whoever sends it: one that changes or removes a record holding a
 * credential the run depends on. And one a configured principal sends to remove or replace its own
 * record, which would end the account every later check signs in as.
 */
function refuseHeld(
	records: OwnRecords,
	write: { identity: Readonly<Record<string, unknown>> | undefined; op: OperationModel; path: Record<string, string> },
	sent: { method: string; principal: string | undefined },
): void {
	const held = heldCredential(write.op, write.path, records.credentials?.() ?? [])
	if (held !== undefined) {
		throw new HeldRecordError(
			`${write.op.operationId} would change ${held.entity} ${held.id}, a credential the run holds ` +
				`(minted by ${held.operationId}): oat never sends that`,
		)
	}
	const replaces = sent.method.toUpperCase() === "DELETE" || sent.method.toUpperCase() === "PUT"
	if (write.identity === undefined || !replaces) return
	if (!ownRecord({ identity: write.identity, op: write.op, path: write.path })) return
	const owner = probeOwner(sent.principal as string)
	const op = write.op.operationId
	throw new HeldRecordError(
		sent.method.toUpperCase() === "DELETE"
			? `${op} would remove ${owner}'s own record: oat never sends that`
			: `${op} is a full replace of ${owner}'s own record, which could clear its sign-in fields: oat never sends that`,
	)
}

/**
 * `client`, and every view of it, refusing any write that would still change a protected field of
 * its sender's own record (`ProtectedWriteError`, nothing sent): what every check sends through, so
 * a check that picked such a field stands down, naming it, whatever built its body.
 */
export function guardedClient(client: Client, records: OwnRecords, model: SpecModel): Client {
	const resolve = operationResolver(model)
	const request = async (method: string, path: string, options: RequestOptions): Promise<Exchange> => {
		const principal = "principal" in options.as ? options.as.principal : undefined
		const identity = principal === undefined ? undefined : records.identityOf(principal)
		const writes = !SAFE.has(method.toUpperCase())
		const resolved = identity === undefined && !writes ? null : resolve(method, path)
		const op = resolved === null ? undefined : model.byOperationId.get(resolved.operationId)
		if (op !== undefined && resolved !== null) {
			refuse(records, { identity, op, path: resolved.pathParams }, { body: options.body, method, principal })
		}
		const exchange = await client.request(method, path, options)
		if (op?.identity === SELF_IDENTITY && SAFE.has(method.toUpperCase()) && exchange.status < 300) {
			records.learn?.(principal as string, exchange.responseBody)
		}
		return exchange
	}
	return new Proxy(client, {
		get(target, property, receiver) {
			if (property === "request") return request
			if (property === "view") {
				return (...args: Parameters<Client["view"]>) => guardedClient(target.view(...args), records, model)
			}
			return Reflect.get(target, property, receiver)
		},
	})
}
