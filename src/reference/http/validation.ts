/** What a write body may carry, coerced to the types the schema declares. */

import type { DefectSet } from "../defects/defect-set.ts"
import type { EntityDef, FieldDef } from "../model/types.ts"
import { writableFields } from "../model/fields.ts"
import type { Row } from "../store-api.ts"
import { HttpError } from "./errors.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i

const invalid = (message: string): HttpError => new HttpError(400, "invalid_input", message)

/** What a write body is checked against: the entity, the kind of write, and the defects in force. */
export interface BodyRules {
	entity: EntityDef
	mode: "create" | "update" | "replace"
	defects: DefectSet
	/** Under WRITE_BODY_NOT_VALIDATED: nothing is required, and a value its field refuses is dropped. */
	lenient?: boolean
}

export function validateBody(body: unknown, rules: BodyRules): Row {
	const { entity, mode, defects } = rules
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw invalid("request body must be a JSON object")
	}
	const input = body as Row
	const allowed = new Map(writableFields(entity, mode === "create" ? "create" : "update").map((f) => [f.name, f]))
	for (const key of Object.keys(input)) admit(key, allowed, rules)
	/* A create, and a replacing update, must carry every required field. */
	if (mode !== "update" && !defects.has("REQUIRED_NOT_VALIDATED") && rules.lenient !== true) {
		const missing = [...allowed.values()].find((field) => field.required === true && input[field.name] === undefined)
		if (missing !== undefined) throw invalid(`field "${missing.name}" is required`)
	}
	const out: Row = {}
	for (const [key, value] of Object.entries(input)) {
		const field = allowed.get(key)
		if (field === undefined) continue
		const kept = rules.lenient === true ? parsed(field, value, defects) : { value: coerceField(field, value, defects) }
		if (kept !== undefined) out[key] = kept.value
	}
	return out
}

/* The value as the field takes it, or undefined when it refuses it: a lenient update drops that one. */
function parsed(field: FieldDef, value: unknown, defects: DefectSet): { value: unknown } | undefined {
	try {
		return { value: coerceField(field, value, defects) }
	} catch {
		return undefined
	}
}

/* A key the body may carry: writable, or — under the defect — immutable or generated too. */
function admit(key: string, allowed: Map<string, FieldDef>, { entity, defects }: BodyRules): void {
	if (allowed.has(key)) return
	const known = entity.fields.find((f) => f.name === key)
	if (known === undefined) throw invalid(`unknown field "${key}"`)
	if (known.immutable !== true && known.generated !== true) throw invalid(`unknown field "${key}"`)
	if (!defects.has("IMMUTABLE_WRITABLE")) throw invalid(`field "${key}" is not writable`)
	allowed.set(key, known)
}

export function coerceField(field: FieldDef, value: unknown, defects: DefectSet): unknown {
	if (value === null) {
		if (field.nullable !== true) throw invalid(`field "${field.name}" is not nullable`)
		return null
	}
	switch (field.type) {
		case "integer":
		case "number":
			return coerceNumber(field, value)
		case "array":
			return coerceArray(field, value)
		case "object":
			return coerceObject(field, value)
		case "boolean":
			if (typeof value !== "boolean") throw invalid(`field "${field.name}" must be a boolean`)
			return value
		default:
			return coerceString(field, value, defects)
	}
}

function coerceNumber(field: FieldDef, value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(`field "${field.name}" must be a number`)
	if (field.type === "integer" && !Number.isInteger(value)) throw invalid(`field "${field.name}" must be an integer`)
	if (
		(field.minimum !== undefined && value < field.minimum) ||
		(field.maximum !== undefined && value > field.maximum) ||
		(field.multipleOf !== undefined && !Number.isInteger(value / field.multipleOf))
	) {
		throw invalid(`field "${field.name}" is out of range`)
	}
	return value
}

function coerceArray(field: FieldDef, value: unknown): string[] {
	const allowed = field.items ?? []
	if (
		!Array.isArray(value) ||
		value.length > 5 ||
		value.some((element) => typeof element !== "string" || !allowed.includes(element))
	) {
		throw invalid(`field "${field.name}" must be a list of ${allowed.join(", ")}`)
	}
	return [...(value as string[])]
}

function coerceObject(field: FieldDef, value: unknown): { x: number; y: number } {
	if (field.ref !== "Point" || !isPoint(value))
		throw invalid(`field "${field.name}" must be a ${field.ref ?? "object"}`)
	return { x: value.x, y: value.y }
}

function coerceString(field: FieldDef, value: unknown, defects: DefectSet): string {
	if (typeof value !== "string") throw invalid(`field "${field.name}" must be a string`)
	if (field.maxLength !== undefined && value.length > field.maxLength && !defects.has("MAXLENGTH_NOT_VALIDATED")) {
		throw invalid(`field "${field.name}" exceeds maxLength`)
	}
	if (field.enum !== undefined && !field.enum.includes(value) && !defects.has("ENUM_NOT_VALIDATED")) {
		throw invalid(`field "${field.name}" must be one of ${field.enum.join(", ")}`)
	}
	if (field.const !== undefined && value !== field.const)
		throw invalid(`field "${field.name}" must be "${field.const}"`)
	assertFormat(field, value)
	assertPatterns(field, value)
	return defects.has("STRING_PAYLOAD_MANGLED") ? value.replace(/[^\x20-\x7E]/g, "").trim() : value
}

/* The minimum, in code points, and every pattern the field declares. */
function assertPatterns(field: FieldDef, value: string): void {
	if (field.minLength !== undefined && [...value].length < field.minLength) {
		throw invalid(`field "${field.name}" is shorter than ${field.minLength}`)
	}
	for (const pattern of field.patterns ?? []) {
		if (!new RegExp(pattern, "u").test(value)) throw invalid(`field "${field.name}" must match ${pattern}`)
	}
}

function assertFormat(field: FieldDef, value: string): void {
	if (field.format === "date-time" && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) {
		throw invalid(`field "${field.name}" must be an RFC 3339 date-time`)
	}
	if (field.format === "uuid" && !UUID.test(value)) throw invalid(`field "${field.name}" must be a UUID`)
}

/** The value a field takes when nobody supplied one. */
export function emptyValue(field: FieldDef): unknown {
	if (field.nullable === true) return null
	if (field.type === "array") return []
	if (field.type === "boolean") return false
	if (field.type === "integer" || field.type === "number") return 0
	return field.enum?.[0] ?? ""
}

function isPoint(value: unknown): value is { x: number; y: number } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false
	const { x, y } = value as { x?: unknown; y?: unknown }
	return Object.keys(value).length === 2 && Number.isInteger(x) && Number.isInteger(y)
}

/** A path identifier as the type its entity declares: a malformed one is a 400, as real frameworks answer before a handler runs. */
export function pathId(entities: readonly EntityDef[], param: string, raw: string): string | number {
	const owner = entities.find((entity) => entity.itemParam === param)
	const identity = owner?.fields.find((field) => field.name === owner.identity)
	if (identity?.type === "integer") {
		if (!/^[1-9]\d{0,14}$/.test(raw)) throw invalid(`"${raw}" is not a valid ${param}`)
		return Number(raw)
	}
	if (identity?.format === "uuid" && !UUID.test(raw)) throw invalid(`"${raw}" is not a valid ${param}`)
	return raw
}

/**
 * Reads a form-encoded body into the types the schema declares.
 *
 * A form carries only strings, so a correct backend coerces each field by its declared type —
 * exactly what it would have to do in production.
 */
export function formFields(entity: EntityDef, text: string): Row {
	const out: Row = {}
	for (const [key, raw] of new URLSearchParams(text)) {
		const field = entity.fields.find((candidate) => candidate.name === key)
		/* A form repeats the key once per element. */
		out[key] = field?.type === "array" ? [...((out[key] as unknown[] | undefined) ?? []), raw] : formValue(field, raw)
	}
	return out
}

function formValue(field: FieldDef | undefined, raw: string): unknown {
	if (field?.type === "integer" || field?.type === "number") return raw.trim() === "" ? raw : Number(raw)
	if (field?.type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw
	return raw
}
