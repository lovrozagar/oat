import { requestContent } from "../../../spec/collection/request.ts"
import { isProbeExchange } from "../../probe-judging.ts"
import type { OperationModel } from "../../../spec/graph/types.ts"
import { normalizeSchema } from "../../../spec/schema.ts"
import { encodeForOperation } from "../../body/encode.ts"
import type { RequestOptions } from "../../../client/types.ts"
import type { Exchange } from "../../exchange.ts"
import { fillPath } from "../../fill-path.ts"
import { buildCohort, type CohortMember, ordinaryRequestSchema } from "../../fixture.ts"
import { distinctValue } from "../../generate/probes.ts"
import { uniquifyProbeBody } from "../../unique.ts"
import type { UploadContext } from "../../upload.ts"
import { type Record_ } from "../../world/records.ts"
import { stringProperties } from "../../world/schema.ts"
import type { CheckContext } from "../core/context.ts"
import { reserveClientIdentity, saltOf } from "./identity.ts"
import type { JsonSchema } from "../../../spec/types.ts"

/** The schema of `field` as the item's representation declares it. */
export function propertySchemaOf(
	ctx: Pick<CheckContext, "listOp" | "model">,
	field: string,
	op?: OperationModel,
): JsonSchema | undefined {
	const request = op === undefined ? null : requestSchemaOf(ctx, op)
	const fromRequest = (request?.properties as Record<string, JsonSchema> | undefined)?.[field]
	if (fromRequest !== undefined) return normalizeSchema(fromRequest, { direction: "request" })
	const item = (ctx.listOp.collection?.itemSchema?.properties ?? {}) as Record<string, JsonSchema>
	return item[field] === undefined ? undefined : normalizeSchema(item[field], { direction: "request" })
}

/** A valid value for `field` that differs from `current` — what a write probe changes it to. */
export function changedValue(ctx: CheckContext, field: string, current: unknown, op?: OperationModel): unknown {
	const schema = propertySchemaOf(ctx, field, op)
	if (schema === undefined) return undefined
	const made = distinctValue(schema, current, { defs: ctx.model.defs, nonce: ctx.nonce, variant: "lexical-last" })
	return made.ok ? made.value : undefined
}

/**
 * The properties `op`'s request schema declares that an ordinary body leaves out: readOnly ones, and
 * optional ones marked x-privileged, which only the highest rank may set (`ordinaryRequestSchema`).
 */
export function withheldProperties(ctx: Pick<CheckContext, "model">, op: OperationModel | undefined): Set<string> {
	const schema = op === undefined ? null : requestSchemaOf(ctx, op)
	if (schema === null) return new Set()
	const kept = (ordinaryRequestSchema(schema).properties ?? {}) as object
	return new Set(Object.keys((schema.properties ?? {}) as object).filter((name) => !Object.hasOwn(kept, name)))
}

/** The first non-empty string field of `record` the update may change: not fixed, not withheld. */
export function pickWritableStringField(ctx: CheckContext, record: Record_): string | null {
	const immutable = new Set([
		...(ctx.updateOp?.immutable ?? []),
		...(ctx.updateOp?.generated ?? []),
		...withheldProperties(ctx, ctx.updateOp),
	])
	for (const [key, value] of Object.entries(record)) {
		if (immutable.has(key) || key === ctx.identity) continue
		if (/_at$|_id$/.test(key)) continue
		if (typeof value === "string" && value !== "") return key
	}
	return null
}

export async function createExchange(ctx: CheckContext): Promise<Exchange | undefined> {
	const createOp = ctx.createOp
	if (createOp === undefined) return undefined
	let resolved: string
	try {
		resolved = fillPath(createOp.path, ctx.scope)
	} catch {
		return undefined
	}
	/* By operation, then by the resolved path below the base URL: a pathname comparison misses
	 * every exchange once the API is mounted under a prefix. */
	/* The lane's own create, never a security probe that a broken API let through. */
	const found = ctx.client
		.exchangesFor(createOp.operationId)
		.find((e) => !isProbeExchange(e) && e.status < 300 && ctx.client.relativePath(e.url) === resolved)
	return found === undefined ? undefined : ctx.client.hydrate(found)
}

/** Builds a body that should be accepted, for use as the base of a negative probe. */
export function validBody(ctx: CheckContext, schema: JsonSchema): Record<string, unknown> {
	const salt = `${ctx.nonce}b${saltOf(ctx)}`
	/* One variant asked for, one member made. */
	const [member] = buildCohort(schema, ctx.seed, {
		variants: ["baseline"],
		defs: ctx.model.defs,
		/* Every string carries the body's own salt, not only the unique ones: a server that derives an
		 * undeclared key from a name (a slug) refuses a record named like one the cohort holds. */
		distinct: new Set([...(ctx.uniqueSets ?? []).flat(), ...stringProperties(schema)]),
		nonce: salt,
		operationId: ctx.createOp?.operationId ?? ctx.entityName,
	}) as [CohortMember]
	let body = member.body
	const sets = ctx.uniqueSets ?? []
	if (sets.length > 0) body = uniquifyProbeBody(body, sets, { schema, token: `p${salt}` })
	return reserveClientIdentity(ctx, body, schema, salt)
}

export function requestSchemaOf(ctx: Pick<CheckContext, "model">, op: OperationModel): JsonSchema | null {
	const raw = ctx.model.rawOperations.get(op.operationId)
	const picked = raw === undefined ? null : requestContent(raw)
	return picked === null ? null : picked.schema
}

/** Where an operation body is encoded for, and the fields it leaves out on purpose. */
interface OpBodyPlacement {
	variant?: string | undefined
	index?: number | undefined
	uploads?: UploadContext | undefined
	omit?: ReadonlySet<string> | undefined
}

export async function encodeOpBody(
	ctx: CheckContext,
	op: OperationModel,
	fields: Record<string, unknown>,
	{ variant = "baseline", index = 0, uploads = ctx.uploads, omit }: OpBodyPlacement = {},
): Promise<Pick<RequestOptions, "body" | "contentType">> {
	const encoded = await encodeForOperation(op, ctx.model, { fields, index, omit, uploads, variant })
	return encoded.contentType === undefined
		? { body: encoded.body }
		: { body: encoded.body, contentType: encoded.contentType }
}
