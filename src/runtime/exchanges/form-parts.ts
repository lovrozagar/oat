/** A multipart part as the journal and the transcript keep it: a field's value, or a file's address. */

import { isSecretJsonKey } from "../../security/credential-names.ts"
import { REDACTED } from "../../security/redact.ts"
import type { FormPart } from "../exchange.ts"

/** A text field, its value scrubbed when the field names a secret. */
export function formFieldPart(field: string, value: string): FormPart {
	return { field, value: isSecretJsonKey(field) ? REDACTED : value }
}

/** A file part by its size and hash; the bytes themselves are kept elsewhere or not at all. */
export function formFilePart(field: string, file: File, stored: { bytes: number; sha256: string }): FormPart {
	return {
		bytes: stored.bytes,
		field,
		filename: file.name,
		mediaType: file.type || "application/octet-stream",
		sha256: stored.sha256,
	}
}
