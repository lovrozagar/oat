import { requestContent } from "../../../../spec/collection.ts"
import type { OperationModel } from "../../../../spec/graph.ts"
import { payloadFits, REQUIRED_IDS, STRING_PAYLOADS, type StringPayload } from "../../../payloads.ts"
import type { CheckContext } from "../../core/context.ts"
import { propertySchemaOf, requestSchemaOf } from "../../payloads/body.ts"

export const ASCII_PAYLOAD_PROBE = "oat-payload-probe"

export interface PayloadField {
	name: string
	maxLength: number | undefined
	minLength: number | undefined
}

type Schema = Record<string, unknown>

/** The first branch of a `oneOf`/`anyOf` union whose type is `type`. */
function unionBranchOf(union: unknown, type: string): Schema | undefined {
	if (!Array.isArray(union)) return undefined
	return union.find(
		(candidate) =>
			candidate !== null && typeof candidate === "object" && (candidate as { type?: unknown }).type === type,
	) as Schema | undefined
}

/** A string schema with nothing (enum, pattern, format) that would make an arbitrary string invalid. */
function isUnconstrainedString(schema: Schema): boolean {
	const type = schema.type
	const isString = type === "string" || (Array.isArray(type) && type.includes("string"))
	if (!isString && type !== undefined) return false
	if (Array.isArray(schema.enum)) return false
	return typeof schema.pattern !== "string" && typeof schema.format !== "string"
}

function isNullable(propertySchema: Schema, union: unknown): boolean {
	return (
		propertySchema.nullable === true ||
		(Array.isArray(propertySchema.type) && propertySchema.type.includes("null")) ||
		unionBranchOf(union, "null") !== undefined
	)
}

/** The property as a payload target, scored so nullable and roomier fields win; `null` when it cannot be one. */
function payloadCandidate(name: string, propertySchema: Schema): (PayloadField & { score: number }) | null {
	if (propertySchema.readOnly === true) return null
	const union = propertySchema.oneOf ?? propertySchema.anyOf
	const stringSchema = unionBranchOf(union, "string") ?? propertySchema
	if (!isUnconstrainedString(stringSchema)) return null
	const maxLength = typeof stringSchema.maxLength === "number" ? stringSchema.maxLength : undefined
	const minLength = typeof stringSchema.minLength === "number" ? stringSchema.minLength : undefined
	if (maxLength !== undefined && maxLength < 8) return null
	const score = (isNullable(propertySchema, union) ? 1000 : 0) + (maxLength ?? 1024)
	return { maxLength, minLength, name, score }
}

/** Fields a write cannot set to an arbitrary value: immutable, server-generated, or the identity. */
function untouchableFields(ctx: CheckContext): ReadonlySet<string> {
	return new Set([
		...(ctx.updateOp?.immutable ?? []),
		...(ctx.updateOp?.generated ?? []),
		...(ctx.createOp?.generated ?? []),
		ctx.identity,
	])
}

export function pickPayloadField(ctx: CheckContext, op: OperationModel): PayloadField | null {
	const schema = requestSchemaOf(ctx, op)
	const properties = (schema?.properties ?? {}) as Record<string, Schema>
	const immutable = untouchableFields(ctx)
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
 * family. `narrowed` names the entity that ran the whole catalog, when this one did not.
 */
export function payloadCases(
	ctx: CheckContext,
	writeOp: OperationModel,
	field: PayloadField,
): { cases: StringPayload[]; narrowed: string | null } {
	const fitting = STRING_PAYLOADS.filter((payload) => payloadFits(payload.value, field.maxLength, field.minLength))
	const policy = ctx.payloads
	if (policy === undefined || policy.policy === "full") return { cases: fitting, narrowed: null }
	const raw = ctx.model.rawOperations.get(writeOp.operationId)
	const mediaType = raw === undefined ? "" : (requestContent(raw)?.mediaType ?? "")
	const schema = propertySchemaOf(ctx, field.name, writeOp) ?? {}
	const path = `${mediaType}|${JSON.stringify([schema.type ?? "string", schema.format ?? null])}`
	const ranOn = policy.ran.get(path)
	if (ranOn === undefined) {
		policy.ran.set(path, ctx.entityName)
		return { cases: fitting, narrowed: null }
	}
	const representative = new Set<string>(REQUIRED_IDS)
	return { cases: fitting.filter((payload) => representative.has(payload.id)), narrowed: ranOn }
}
