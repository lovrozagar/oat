import { defineCheck } from "../../core/define.ts"
import type { OperationModel } from "../../../../spec/graph/types.ts"
import { ASSERTED, type Outcome, standDown } from "../../../finding.ts"
import { headerValue } from "../../../headers.ts"
import { createdRecordOf } from "../../../created-id.ts"
import { type Record_ } from "../../../world/records.ts"
import { cannot, ready } from "../../core/plan.ts"
import { createExchange, requestSchemaOf } from "../../payloads/body.ts"
import { subjectsOf } from "../../planning/subjects.ts"

export const createPersistsFields = defineCheck<{
	createOp: OperationModel
	properties: Record<string, Record<string, unknown>>
}>({
	plan: (ctx) => {
		const createOp = ctx.createOp
		/* An acknowledgement-only create never echoes the record: nothing to compare. */
		if (createOp === undefined || ctx.records.length === 0 || ctx.createAcknowledged) return cannot()
		const schema = requestSchemaOf(ctx, createOp)
		const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>
		return ready({ createOp, properties })
	},
	dependsOn: ["list.read-after-write"],
	id: "create.persists-submitted-fields",
	judgesTranscript: true,
	needs: "a create operation that echoes the record back",
	subjects: subjectsOf.create,
	async run(ctx, { properties }): Promise<Outcome> {
		const sent = await createExchange(ctx)
		if (sent === undefined || sent.requestBody === undefined)
			return ctx.findings.unresolved(this.id, ctx.entityName, "no create request body was observed")
		const request = submittedFields(sent.requestBody, headerValue(sent.requestHeaders, "content-type"), properties)
		if (Object.keys(request).length === 0) return standDown("the create body was empty")
		const response = createdRecordOf(sent.responseBody ?? {}, ctx.identity, request)

		const dropped = Object.entries(request).filter(([key, value]) => {
			if (value === null || value === undefined) return false
			/* A writeOnly field is accepted and never returned — a password, a secret. */
			if (properties[key]?.writeOnly === true) return false
			if (!Object.hasOwn(response, key)) return true
			return JSON.stringify(response[key]) !== JSON.stringify(value)
		})
		if (dropped.length === 0) return ASSERTED

		return ctx.findings.backend(this.id, ctx.entityName, {
			summary: "create silently discards submitted fields",
			detail:
				`the create response does not carry back ${dropped.length} submitted field(s): ` +
				dropped
					.slice(0, 4)
					.map(([key, value]) => `${key} sent ${JSON.stringify(value)}, got ${JSON.stringify(response[key])}`)
					.join("; ") +
				". A write that reports success and drops data is worse than one that fails.",
			evidence: [sent],
		})
	},
})

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
		if (typeof part.field === "string" && typeof part.value === "string") entries.push([part.field, part.value])
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

function coerceFormScalar(value: string, of: Record<string, unknown> | undefined): unknown {
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
function coerceFormValue(values: string[], schema: Record<string, unknown> | undefined): unknown {
	const types = [schema?.type].flat()
	if (types.includes("array")) {
		const items = schema?.items as Record<string, unknown> | undefined
		return values.map((value) => coerceFormScalar(value, items))
	}
	/* `formValues` never makes a field without a value. */
	return coerceFormScalar(values.at(-1) as string, schema)
}

/** The fields a create body submitted, a form's typed as the record stores them; `{}` for any other body. */
function submittedFields(
	body: unknown,
	contentType: string | undefined,
	properties: Record<string, Record<string, unknown>>,
): Record_ {
	const form = formValues(body, contentType)
	if (form === null) return isPlainBody(body) ? body : {}
	return Object.fromEntries([...form].map(([key, values]) => [key, coerceFormValue(values, properties[key])]))
}
