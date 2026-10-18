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
