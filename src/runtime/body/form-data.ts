/** Appending fields and files to a multipart body. */

import type { UploadFile } from "../../config/types/hooks.ts"
import type { FieldEncoding } from "./types.ts"

export function appendFile(form: FormData, name: string, file: UploadFile): void {
	const blob = new File([file.bytes], file.filename, { type: file.mediaType })
	form.append(name, blob, file.filename)
}

export function appendFields(form: FormData, fields: Record<string, string | UploadFile>): void {
	for (const [name, value] of Object.entries(fields)) {
		if (typeof value === "string") form.append(name, value)
		else appendFile(form, name, value)
	}
}

function json(item: unknown): Blob {
	return new Blob([JSON.stringify(item)], { type: "application/json" })
}

/**
 * One multipart field: a part per array item, and an object as one JSON part (the OpenAPI
 * default content type for an object in multipart) unless the encoding says otherwise.
 */
export function appendValue(form: FormData, name: string, value: unknown, encoding: FieldEncoding | undefined): void {
	if (encoding?.contentType?.includes("json") === true) {
		form.append(name, json(value))
		return
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (item !== null && typeof item === "object") form.append(name, json(item))
			else form.append(name, String(item))
		}
		return
	}
	if (value !== null && typeof value === "object") {
		form.append(name, json(value))
		return
	}
	form.append(name, String(value))
}
