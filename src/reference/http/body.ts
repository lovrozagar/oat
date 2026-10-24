/** Reading a request body, refused when its type is not the one the route takes. */

import type { DefectSet } from "../defects/defect-set.ts"
import { HttpError } from "./errors.ts"
import type { ReferenceRequest } from "./wire.ts"

export async function readJson(request: ReferenceRequest): Promise<unknown> {
	const text = await request.text()
	if (text.trim() === "") return {}
	try {
		return JSON.parse(text)
	} catch {
		throw new HttpError(400, "invalid_input", "request body is not valid JSON")
	}
}

export function requireJson(request: ReferenceRequest, defects: DefectSet): void {
	requireType(request, defects, "application/json")
}

export function requireForm(request: ReferenceRequest, defects: DefectSet): void {
	requireType(request, defects, "application/x-www-form-urlencoded")
}

function requireType(request: ReferenceRequest, defects: DefectSet, expected: string): void {
	if (defects.has("CONTENT_TYPE_NOT_ENFORCED")) return
	if (!(request.headers["content-type"] ?? "").includes(expected)) {
		throw new HttpError(415, "unsupported_media_type", `expected ${expected}`)
	}
}

/** The kind each field of a fixed body takes: a string, an array of strings, or a boolean the body may leave out. */
export type FieldKinds = Readonly<Record<string, "string" | "string?" | "strings" | "boolean?">>

const ofKind = (value: unknown, kind: FieldKinds[string]): boolean => {
	if (kind === "boolean?") return typeof value === "boolean"
	return kind === "string" || kind === "string?"
		? typeof value === "string"
		: Array.isArray(value) && value.every((item) => typeof item === "string")
}

/** A JSON body holding the fields `kinds` names, each of its kind, an optional one or not; anything else is a 400. */
export async function readFields(
	request: ReferenceRequest,
	defects: DefectSet,
	kinds: FieldKinds,
): Promise<Record<string, unknown>> {
	requireJson(request, defects)
	const body = await readJson(request)
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "invalid_input", "request body must be an object")
	}
	const fields = body as Record<string, unknown>
	const unknown = Object.keys(fields).find((name) => !Object.hasOwn(kinds, name))
	if (unknown !== undefined) throw new HttpError(400, "invalid_input", `field "${unknown}" is not allowed`)
	for (const [name, kind] of Object.entries(kinds)) {
		if (kind.endsWith("?") && !(name in fields)) continue
		if (!(name in fields)) throw new HttpError(400, "invalid_input", `field "${name}" is required`)
		if (!ofKind(fields[name], kind)) throw new HttpError(400, "invalid_input", `field "${name}" has the wrong type`)
	}
	return fields
}
