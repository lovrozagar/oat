/** A multipart part as the journal and the transcript keep it: a field's value, or a file's address. */

import type { Redactor } from "../../security/redact.ts"
import type { FormPart } from "../exchange.ts"

/**
 * A text field: redacted when its name is a secret's or a placed query credential's, and scrubbed
 * of every credential value the run placed otherwise.
 */
export function formFieldPart(field: string, value: string, redactor: Redactor): FormPart {
	return { field, value: redactor.field(field, value) }
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
