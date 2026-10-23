import { requestContent } from "../../../../spec/collection/request.ts"
import type { EntityModel, OperationModel, SpecModel } from "../../../../spec/graph/types.ts"
import { payloadFits, REQUIRED_IDS, STRING_PAYLOADS, type StringPayload } from "../../../payloads.ts"
import type { CheckContext } from "../../core/context.ts"
import { propertySchemaOf, requestSchemaOf, withheldProperties } from "../../payloads/body.ts"
import type { JsonSchema } from "../../../../spec/types.ts"

export const ASCII_PAYLOAD_PROBE = "oat-payload-probe"

export interface PayloadField {
	name: string
	maxLength: number | undefined
	minLength: number | undefined
}

/** The first branch of a `oneOf`/`anyOf` union whose type is `type`. */
function unionBranchOf(union: unknown, type: string): JsonSchema | undefined {
	if (!Array.isArray(union)) return undefined
	return union.find(
		(candidate) =>
			candidate !== null && typeof candidate === "object" && (candidate as { type?: unknown }).type === type,
	) as JsonSchema | undefined
}

/** A string schema with nothing (enum, pattern, format) that would make an arbitrary string invalid. */
function isUnconstrainedString(schema: JsonSchema): boolean {
	const type = schema.type
	const isString = type === "string" || (Array.isArray(type) && type.includes("string"))
	if (!isString && type !== undefined) return false
	if (Array.isArray(schema.enum)) return false
	return typeof schema.pattern !== "string" && typeof schema.format !== "string"
}

function isNullable(propertySchema: JsonSchema, union: unknown): boolean {
	return (
		propertySchema.nullable === true ||
		(Array.isArray(propertySchema.type) && propertySchema.type.includes("null")) ||
		unionBranchOf(union, "null") !== undefined
	)
}

/**
 * The property as a payload target, scored so nullable and roomier fields win; `null` when it cannot
 * be one. A readOnly property never reaches here: `untouchableFields` withholds it.
 */
function payloadCandidate(name: string, propertySchema: JsonSchema): (PayloadField & { score: number }) | null {
	/* A server takes a writeOnly field and never returns it: no read could show a payload survived. */
	if (propertySchema.writeOnly === true) return null
	const union = propertySchema.oneOf ?? propertySchema.anyOf
	const stringSchema = unionBranchOf(union, "string") ?? propertySchema
	if (!isUnconstrainedString(stringSchema)) return null
	const maxLength = typeof stringSchema.maxLength === "number" ? stringSchema.maxLength : undefined
	const minLength = typeof stringSchema.minLength === "number" ? stringSchema.minLength : undefined
	if (maxLength !== undefined && maxLength < 8) return null
	const score = (isNullable(propertySchema, union) ? 1000 : 0) + (maxLength ?? 1024)
	return { maxLength, minLength, name, score }
}

/** What picking a payload field and keying its write path read: the entity's routes in the document. */
export type PayloadSubject = Pick<CheckContext, "createOp" | "identity" | "listOp" | "model" | "readOp" | "updateOp">

/**
 * Fields a write through `op` cannot set to an arbitrary value: immutable, server-generated, the
 * identity, or one an ordinary body leaves out (`withheldProperties`).
 */
function untouchableFields(ctx: PayloadSubject, op: OperationModel): ReadonlySet<string> {
	return new Set([
		...(ctx.updateOp?.immutable ?? []),
		...(ctx.updateOp?.generated ?? []),
		...(ctx.createOp?.generated ?? []),
		...withheldProperties(ctx, op),
		ctx.identity,
	])
}

export function pickPayloadField(ctx: PayloadSubject, op: OperationModel): PayloadField | null {
	const schema = requestSchemaOf(ctx, op)
	const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>
	const immutable = untouchableFields(ctx, op)
	let best: (PayloadField & { score: number }) | null = null
	for (const [name, propertySchema] of Object.entries(properties)) {
		if (immutable.has(name) || /_at$|_id$/.test(name)) continue
		if (propertySchema === null || typeof propertySchema !== "object") continue
		const candidate = payloadCandidate(name, propertySchema)
		if (candidate !== null && (best === null || candidate.score > best.score)) best = candidate
	}
	return best
}

/** Records one payload run fans its cases across. */
export const PAYLOAD_LANES = 4

/**
 * The payload cases one field gets. Under `"per-write-path"`, the whole catalog runs once per
 * write path — the request media type and the field's type and format, which is what decides
 * the code a string goes through — and a field on a path that has had it gets one case of each
 * family. `narrowed` names the entity that ran the whole catalog, when this one did not: the first
 * in plan order to reach the path, however the lanes are timed (`PayloadClaims`).
 */
export async function payloadCases(
	ctx: CheckContext,
	writeOp: OperationModel,
	field: PayloadField,
): Promise<{ cases: StringPayload[]; narrowed: string | null }> {
	const fitting = STRING_PAYLOADS.filter((payload) => payloadFits(payload.value, field.maxLength, field.minLength))
	const policy = ctx.payloads
	if (policy === undefined || policy.policy === "full") return { cases: fitting, narrowed: null }
	const ranOn = await policy.claims.claim(ctx.entityName, writePathOf(ctx, writeOp, field.name))
	if (ranOn === null) return { cases: fitting, narrowed: null }
	const representative = new Set<string>(REQUIRED_IDS)
	return { cases: fitting.filter((payload) => representative.has(payload.id)), narrowed: ranOn }
}

/**
 * The write path a field's string goes through: the request media type and the field's type and
 * format, which is what decides the code a string goes through.
 */
export function writePathOf(subject: PayloadSubject, writeOp: OperationModel, field: string): string {
	const raw = subject.model.rawOperations.get(writeOp.operationId)
	const mediaType = raw === undefined ? "" : (requestContent(raw)?.mediaType ?? "")
	const schema = propertySchemaOf(subject, field, writeOp) ?? {}
	return `${mediaType}|${JSON.stringify([schema.type ?? "string", schema.format ?? null])}`
}

/**
 * The write path `entity`'s payload check probes, read from the document alone; null when it has
 * none. A run that turns out otherwise (an excluded route, a degraded entity) only makes an entity
 * settle without the catalog, or claim a path no entity before it was planned on.
 */
export function plannedWritePath(model: SpecModel, entity: EntityModel): string | null {
	const route = (operationId: string | undefined) => model.byOperationId.get(operationId ?? "")
	const createOp = route(entity.create)
	const updateOp = route(entity.update)
	const readOp = route(entity.read)
	if (createOp === undefined || readOp === undefined) return null
	const writeOp = updateOp ?? createOp
	if (updateOp === undefined && route(entity.delete) === undefined) return null
	const subject = { createOp, identity: entity.identity ?? "id", listOp: route(entity.list), model, readOp, updateOp }
	const field = pickPayloadField(subject, writeOp)
	return field === null ? null : writePathOf(subject, writeOp, field.name)
}
