/**
 * Unique-conflict probes: a documented `x-unique` set is 409 on a duplicate, 2xx is BACKEND_BUG.
 *
 * HTTP 409 is the unique-conflict class. Index names and product `error_key` / `vars.type` are
 * not required. Uniqueness is never inferred from a 409 without the tag.
 */

import { generate } from "./generate/generate.ts"
import { requestContent } from "../spec/collection/request.ts"
import type { OperationModel, SpecModel } from "../spec/graph/types.ts"
import type { JsonSchema } from "../spec/types.ts"

export const UNIQUE_CONFLICT_STATUS = 409

export function isUniqueConflictResponse(op: Pick<OperationModel, "unique">, status: number): boolean {
	return status === UNIQUE_CONFLICT_STATUS && op.unique !== null && op.unique.length > 0
}

/** The idempotency key a unique probe may need. */
export interface IdempotencyKey {
	/** The operation's idempotency header, when it names one. */
	header: string | null
	/** Whether the document requires the header. */
	required: boolean
	/** A key no earlier request sent. */
	fresh: string
}

/**
 * Headers for a unique probe: never the original request's idempotency key, which would replay it.
 * The key is omitted unless the document requires it, in which case a fresh one is sent.
 */
export function uniqueProbeHeaders({ header, required, fresh }: IdempotencyKey): Record<string, string> {
	return required && header !== null && header !== "" ? { [header]: fresh } : {}
}

export function idempotencyHeaderRequired(op: OperationModel, model: SpecModel): boolean {
	if (op.idempotencyHeader === null) return false
	const raw = model.rawOperations.get(op.operationId)
	const params = raw?.parameters ?? []
	const match = params.find((param) => param.in === "header" && param.name === op.idempotencyHeader)
	return match?.required === true
}

export function bodyPropertyNames(op: OperationModel, model: SpecModel): Set<string> {
	const raw = model.rawOperations.get(op.operationId)
	const schema = raw === undefined ? null : (requestContent(raw)?.schema ?? null)
	if (schema === null || typeof schema !== "object") return new Set()
	const props = (schema as { properties?: unknown }).properties
	if (props === null || typeof props !== "object") return new Set()
	return new Set(Object.keys(props as Record<string, unknown>))
}

function propertySchema(schema: JsonSchema | null, name: string): JsonSchema | undefined {
	if (schema === null) return undefined
	const props = schema.properties
	if (props === null || typeof props !== "object") return undefined
	const value = (props as Record<string, unknown>)[name]
	return value !== null && typeof value === "object" ? (value as JsonSchema) : undefined
}

/**
 * A set is probeable when at least one column is on the create/update JSON or form body.
 *
 * Path / tenant / `x-generated` columns may fill set identity from scope, but a set with no
 * body columns is skipped, not failed. Update sets whose columns are all `x-immutable` are
 * skipped.
 */
export interface UniqueProbe {
	phase: "create" | "update"
	/** The sets to consider; the operation's own `x-unique` sets when absent. */
	sets?: string[][]
}

export function probeableUniqueSets(
	op: OperationModel,
	model: SpecModel,
	{ phase, sets = op.unique ?? [] }: UniqueProbe,
): string[][] {
	if (sets.length === 0) return []
	const body = bodyPropertyNames(op, model)
	const generated = new Set(op.generated)
	const immutable = new Set(op.immutable)
	return sets.filter((set) => {
		if (phase === "update" && set.length > 0 && set.every((col) => immutable.has(col))) return false
		return set.some((col) => body.has(col) && !generated.has(col))
	})
}

export function uniqueTupleCollides(
	body: Record<string, unknown>,
	sets: string[][],
	existing: Array<Record<string, unknown>>,
): boolean {
	return sets.some((set) => {
		const cols = set.filter((col) => Object.hasOwn(body, col))
		if (cols.length === 0) return false
		return existing.some((row) => cols.every((col) => JSON.stringify(row[col]) === JSON.stringify(body[col])))
	})
}

/** What a fresh unique value is drawn from: the body's schema, and a token no earlier record used. */
export interface Uniquifier {
	schema: JsonSchema | null
	token: string
}

export function uniquifyProbeBody(
	body: Record<string, unknown>,
	sets: string[][],
	{ schema, token }: Uniquifier,
): Record<string, unknown> {
	if (sets.length === 0) return { ...body }
	const out = { ...body }
	const columns = new Set(sets.flat())
	for (const col of columns) {
		if (!Object.hasOwn(out, col)) continue
		out[col] = distinctUniqueValue(out[col], token, propertySchema(schema, col))
	}
	return out
}

/**
 * A value for a unique column that no earlier record — this run's or an earlier run's — holds.
 *
 * Drawn from the column's own schema with the token mixed in, so it honours `maximum`,
 * `multipleOf`, `enum`, `pattern` and `format`. Appending a suffix to whatever was there broke
 * every one of those. Where the schema admits nothing new, the value is left as it was and the
 * caller's collision check decides.
 */
function distinctUniqueValue(value: unknown, token: string, schema: JsonSchema | undefined): unknown {
	if (schema === undefined) return value
	let h = 0
	for (const ch of token) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0
	const result = generate(
		{ properties: { value: schema }, required: ["value"], type: "object" },
		{ distinct: new Set(["value"]), index: h % 1000, nonce: token },
	)
	if (!result.ok) return value
	const next = (result.value as Record<string, unknown>)["value"]
	return JSON.stringify(next) === JSON.stringify(value) ? value : next
}

/** One unique set as a write can reach it: which columns the body sends, and where the rest come from. */
export interface UniqueSetWrite {
	set: string[]
	/** Path and tenant values, for columns the body does not carry. */
	scope: Record<string, string>
	/** Columns the write's body declares. */
	bodyColumns: ReadonlySet<string>
	/** Columns the server fills, never sent. */
	generated: readonly string[]
}

/**
 * Overlays one unique set's values from a known row onto a body that otherwise does not collide.
 *
 * Other unique sets keep the uniquified values so two sets are never collided in one request.
 */
export function collisionCreateBody(
	base: Record<string, unknown>,
	known: Record<string, unknown>,
	write: UniqueSetWrite,
): Record<string, unknown> | null {
	const { bodyColumns, generated, scope, set } = write
	const out = { ...base }
	const skip = new Set(generated)
	let wrote = false
	for (const col of set) {
		if (!bodyColumns.has(col) || skip.has(col)) continue
		const value = known[col] ?? scope[col]
		if (value === undefined) return null
		out[col] = value
		wrote = true
	}
	return wrote ? out : null
}

/** The update that makes `target` hold `source`'s values on a whole unique set, or `null` when it cannot. */
export function collisionUpdatePatch(
	source: Record<string, unknown>,
	target: Record<string, unknown>,
	write: UniqueSetWrite & { immutable: readonly string[] },
): Record<string, unknown> | null {
	const { bodyColumns, generated, immutable, scope, set } = write
	const skip = new Set([...immutable, ...generated])
	const patch: Record<string, unknown> = {}
	for (const col of set) {
		const value = source[col] ?? scope[col]
		if (value === undefined) return null
		if (!bodyColumns.has(col) || skip.has(col)) {
			/* A column the update cannot write must already agree, or the two rows would still
			 * differ on the set after the write — and accepting it would be correct. */
			if (JSON.stringify(target[col] ?? scope[col]) !== JSON.stringify(value)) return null
			continue
		}
		patch[col] = value
	}
	return Object.keys(patch).length > 0 ? patch : null
}
