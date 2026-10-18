import type { Row } from "./store.ts"
import { HttpError } from "./http.ts"
import { hasDefect, writableFields, type Entity, type Field, type World } from "./types.ts"

/* The body a world accepts: defaults for a new row, and validation of a create or update. */

const IMMUTABLE = ["id", "org_id", "created_at"]

export function defaults(entity: Entity): Row {
	const row: Row = {}
	for (const field of entity.fields) {
		if (field.required === true) continue
		if (field.enum !== undefined) row[field.name] = field.enum[0] ?? null
		else if (field.type === "integer" || field.type === "number") row[field.name] = 0
		else if (field.type === "boolean") row[field.name] = true
		else row[field.name] = field.nullable === true ? null : ""
	}
	return row
}

export function validateBody(entity: Entity, input: Row, phase: "create" | "update", world: World): Row {
	assertWritable(entity, input, world)
	if (phase === "create" && !hasDefect(world, "skip-required")) assertRequired(entity, input)
	for (const field of entity.fields) {
		const value = input[field.name]
		if (value === undefined || value === null) continue
		assertValue(field, value, world)
	}
	return input
}

function assertWritable(entity: Entity, input: Row, world: World): void {
	const allowed = new Set(writableFields(entity))
	const acceptImmutable = hasDefect(world, "accept-immutable")
	const immutable = acceptImmutable ? new Set<string>() : new Set(IMMUTABLE)
	if (acceptImmutable) {
		for (const key of IMMUTABLE) allowed.add(key)
	}
	for (const key of Object.keys(input)) {
		if (immutable.has(key)) throw new HttpError(400, "invalid_input", `field "${key}" is not writable`)
		if (!allowed.has(key)) throw new HttpError(400, "invalid_input", `unknown field "${key}"`)
	}
}

function assertRequired(entity: Entity, input: Row): void {
	for (const field of entity.fields) {
		if (field.required !== true) continue
		const value = input[field.name]
		if (value === undefined || value === null || value === "") {
			throw new HttpError(400, "invalid_input", `field "${field.name}" is required`)
		}
	}
}

function assertValue(field: Field, value: unknown, world: World): void {
	if (field.enum !== undefined && !field.enum.includes(String(value)) && !hasDefect(world, "skip-enum")) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be one of ${field.enum.join(", ")}`)
	}
	if (
		field.maxLength !== undefined &&
		typeof value === "string" &&
		value.length > field.maxLength &&
		!hasDefect(world, "skip-max-length")
	) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" exceeds maxLength ${field.maxLength}`)
	}
	if ((field.type === "integer" || field.type === "number") && typeof value !== "number") {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be a number`)
	}
}
