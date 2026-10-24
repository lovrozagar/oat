import type { Check } from "../../core/check.ts"
import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import type { Exchange } from "../../../exchange.ts"
import { fillPath } from "../../../fill-path.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { headerValue } from "../../../headers.ts"
import { createdIdOf, createdRecordOf } from "../../../created-id.ts"
import { idOf, type Record_ } from "../../../world/records.ts"
import { type CheckContext, isListed } from "../../core/context.ts"
import { cannot, ready } from "../../core/plan.ts"
import { readRecord } from "../../isolation/scratch.ts"
import { createExchange, requestSchemaOf } from "../../payloads/body.ts"
import { itemSchemaOf } from "../../payloads/item-schema.ts"
import { itemParamFor, subjectsOf } from "../../planning/subjects.ts"
import { readSet } from "../../sets/read.ts"
import type { JsonSchema } from "../../../../spec/types.ts"

interface Plan {
	createOp: OperationModel
	properties: Record<string, JsonSchema>
	/** The fields the record's schema declares; unset when it is unknown, and every field is judged. */
	declared?: readonly string[]
}

/**
 * A create must persist what it was sent. The record read back through the item read, by the id the
 * create answered (or the client chose), is what was stored; an echoed record speaks for the create
 * too. A field counts as dropped only when neither holds it as sent: an echo that leaves a field
 * out is not a lost write once the read shows it, and a read that leaves out what the create echoed
 * is a read-side disagreement, judged by `consistency.projections-agree`. An acknowledgment-only
 * create, with no record to read back, gives nothing to judge.
 */
export const createPersistsFields: Check<Plan> = defineCheck<Plan>({
	plan: (ctx) => {
		const createOp = ctx.createOp
		if (createOp === undefined || ctx.records.length === 0) return cannot()
		const schema = requestSchemaOf(ctx, createOp)
		const properties = (schema?.properties ?? {}) as Record<string, JsonSchema>
		const record = itemSchemaOf({ listOp: ctx.listOp, model: ctx.model, readOp: ctx.readOp })
		const fields = record?.properties as Record<string, JsonSchema> | undefined
		const declared = fields === undefined ? undefined : Object.keys(fields)
		return ready({ createOp, properties, ...(declared === undefined ? {} : { declared }) })
	},
	dependsOn: ["list.read-after-write"],
	id: "create.persists-submitted-fields",
	judgesTranscript: true,
	needs: "a create operation that echoes the record back, or an item read to read it back by",
	subjects: subjectsOf.create,
	async run(ctx, { createOp, properties, declared }): Promise<Outcome> {
		const sent = await createExchange(ctx)
		if (sent === undefined || sent.requestBody === undefined)
			return ctx.findings.unresolved(this.id, ctx.entityName, "no create request body was observed")
		const request = submittedFields(sent.requestBody, headerValue(sent.requestHeaders, "content-type"), properties)
		if (Object.keys(request).length === 0) return standDown("the create body was empty")
		const echoed = createdRecordOf(sent.responseBody ?? {}, ctx.identity, request)
		const back = await readBack(ctx, createOp, sent, request)
		const judged = Object.entries(request).filter(
			/*
			 * A writeOnly field is accepted and never returned — a password, a secret. Nor can a read show a
			 * field its record's schema never declares, a product_id the record answers as product say.
			 */
			([key, value]) =>
				value !== null &&
				value !== undefined &&
				properties[key]?.writeOnly !== true &&
				(declared === undefined || declared.includes(key)),
		)
		/* The create echoed a record when the answer holds a submitted field beyond the identity. */
		const echoes = judged.some(([key]) => key !== ctx.identity && Object.hasOwn(echoed, key))
		if (back.record === undefined && !echoes)
			return standDown(`${createOp.operationId} answered an acknowledgment, not the record, and ${back.why}`)

		const dropped = await droppedFields(ctx, judged, { back, echoed })
		if (dropped.length === 0) return ASSERTED

		/* A dropped field is missing from the echo too, so an echoing create is reported by its echo. */
		const read = echoes || back.record === undefined ? undefined : back
		const shown = read?.record ?? echoed
		const where =
			read === undefined ? "the create response does not carry back" : `the record ${read.via} does not hold`
		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "create silently discards submitted fields",
			detail:
				`${where} ${dropped.length} submitted field(s): ` +
				dropped
					.slice(0, 4)
					.map(([key, value]) => `${key} sent ${JSON.stringify(value)}, got ${JSON.stringify(shown[key])}`)
					.join("; ") +
				". A write that reports success and drops data is worse than one that fails.",
			evidence: back.exchange === undefined ? [sent] : [sent, back.exchange],
		})
	},
})

/** Whether `record` holds the submitted field as it was sent. */
function holds(record: Record_, [key, value]: [string, unknown]): boolean {
	return Object.hasOwn(record, key) && JSON.stringify(record[key]) === JSON.stringify(value)
}

/** The created record as the item read shows it, or why there is none; `id` is what it was read under. */
type ReadBack =
	| { record: Record_; via: string; exchange: Exchange; id: string }
	| { record?: undefined; why: string; exchange?: Exchange; id?: string }

/**
 * The submitted fields no witness holds as sent: the echo, the record read back, or the row the
 * listing shows under the same id. A field the listing holds was stored, and an item read leaving
 * it out is a read-side disagreement; behind an acknowledgment the read is the only other witness.
 */
async function droppedFields(
	ctx: CheckContext,
	judged: Array<[string, unknown]>,
	{ back, echoed }: { back: ReadBack; echoed: Record_ },
): Promise<Array<[string, unknown]>> {
	const unseen = judged.filter((field) => !holds(echoed, field) && !(back.record && holds(back.record, field)))
	if (unseen.length === 0 || back.id === undefined) return unseen
	const listed = await listedRow(ctx, back.id)
	return listed === undefined ? unseen : unseen.filter((field) => !holds(listed, field))
}

/** The listed row under `id`, when the entity has a listing that shows it. */
async function listedRow(ctx: CheckContext, id: string): Promise<Record_ | undefined> {
	if (!isListed(ctx)) return undefined
	const listing = await readSet(ctx)
	return listing.items.find((row) => idOf(row, ctx.identity) === id)
}

/** The id the create answered, in its body or its Location, or the one the client chose; read back through the item read. */
async function readBack(
	ctx: CheckContext,
	createOp: OperationModel,
	sent: Exchange,
	request: Record_,
): Promise<ReadBack> {
	const readOp = ctx.readOp
	if (readOp === undefined) return { why: "the entity has no item read to read it back by" }
	const chosen = request[ctx.identity]
	const id =
		createdIdOf({ createOp, exchange: sent, model: ctx.model, sent: request })?.value ??
		(typeof chosen === "string" || typeof chosen === "number" ? chosen : undefined)
	if (id === undefined) return { why: "named no id to read it back by" }
	const exchange = await ctx.client.get(fillPath(readOp.path, { ...ctx.scope, ...itemParamFor(ctx, String(id)) }), {
		as: { principal: ctx.actor.id },
		operationId: readOp.operationId,
	})
	const record = exchange.status >= 200 && exchange.status < 300 ? readRecord(readOp, exchange) : undefined
	if (record === undefined)
		return {
			exchange,
			id: String(id),
			why: `${readOp.operationId} answered ${exchange.status} for it under ${String(id)}`,
		}
	return { exchange, id: String(id), record, via: `${readOp.operationId} reads back under ${String(id)}` }
}

type FormEntry = [string, string]

/* A JSON object body — and the transcript's shape for a urlencoded one. */
function isPlainBody(body: unknown): body is Record<string, unknown> {
	return body !== null && typeof body === "object" && !Array.isArray(body)
}

/* The transcript keeps a urlencoded body as its fields, repeated keys as arrays. */
function urlencodedEntries(body: Record<string, unknown>): FormEntry[] {
	const entries: FormEntry[] = []
	for (const [name, value] of Object.entries(body)) {
		for (const item of [value].flat()) if (typeof item === "string") entries.push([name, item])
	}
	return entries
}

function formDataEntries(body: FormData): FormEntry[] {
	const entries: FormEntry[] = []
	for (const [name, value] of body.entries()) if (typeof value === "string") entries.push([name, value])
	return entries
}

/* A multipart body as oat encodes it: the text parts, each a field and a value. */
function multipartEntries(body: unknown): FormEntry[] | null {
	if (body === null || typeof body !== "object" || !Array.isArray((body as { parts?: unknown }).parts)) return null
	const entries: FormEntry[] = []
	for (const part of (body as { parts: Array<Record<string, unknown>> }).parts) {
		if (typeof part["field"] === "string" && typeof part["value"] === "string")
			entries.push([part["field"], part["value"]])
	}
	return entries
}

/** Every value a form body carried, by field — repeated keys are how a form sends an array. */
function formValues(body: unknown, contentType?: string): Map<string, string[]> | null {
	const urlencoded = contentType?.toLowerCase().includes("application/x-www-form-urlencoded") === true
	let entries: FormEntry[] | null
	if (urlencoded && isPlainBody(body) && !(body instanceof URLSearchParams)) entries = urlencodedEntries(body)
	else if (typeof FormData !== "undefined" && body instanceof FormData) entries = formDataEntries(body)
	else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) entries = [...body.entries()]
	else entries = multipartEntries(body)
	if (entries === null) return null
	const out = new Map<string, string[]>()
	for (const [name, value] of entries) out.set(name, [...(out.get(name) ?? []), value])
	return out
}

function coerceFormScalar(value: string, of: JsonSchema | undefined): unknown {
	const kinds = [of?.type].flat()
	if (kinds.includes("integer") || kinds.includes("number")) {
		const number = Number(value)
		return value.trim() !== "" && Number.isFinite(number) ? number : value
	}
	if (kinds.includes("boolean") && (value === "true" || value === "false")) return value === "true"
	return value
}

/**
 * What a form-submitted field means once the property type is applied: the record stores
 * `1.5`, not `"1.5"`, and a field sent three times is an array of three. Comparing the raw form
 * strings with the typed record reads every non-string field as dropped.
 */
function coerceFormValue(values: string[], schema: JsonSchema | undefined): unknown {
	const types = [schema?.type].flat()
	if (types.includes("array")) {
		const items = schema?.items as JsonSchema | undefined
		return values.map((value) => coerceFormScalar(value, items))
	}
	/* `formValues` never makes a field without a value. */
	return coerceFormScalar(values.at(-1) as string, schema)
}

/** The fields a create body submitted, a form's typed as the record stores them; `{}` for any other body. */
function submittedFields(
	body: unknown,
	contentType: string | undefined,
	properties: Record<string, JsonSchema>,
): Record_ {
	const form = formValues(body, contentType)
	if (form === null) return isPlainBody(body) ? body : {}
	return Object.fromEntries([...form].map(([key, values]) => [key, coerceFormValue(values, properties[key])]))
}
