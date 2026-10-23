/** The OpenAPI versions oat reads, and the refusal of every other. */

import type { RawOf } from "../../config/types/raw.ts"
import type { OpenApiDocument } from "../types.ts"
import { UsageError } from "../../errors/usage-error.ts"

const READS = "oat reads OpenAPI 3.0–3.2 only"

/**
 * Accepts an OpenAPI 3.0, 3.1 or 3.2 document. Swagger 2, an OpenAPI below 3.0 and one newer than
 * 3.2 are documents the caller must convert or choose otherwise, so each is a `UsageError` naming
 * its version. A document with no version string is not an OpenAPI document at all.
 */
/** A parsed document's top-level fields before it is known to be OpenAPI: its own, and Swagger 2's marker. */
export type RawDocument = RawOf<OpenApiDocument & { swagger: unknown }>

export function assertVersion(doc: RawDocument, source: string): void {
	if (doc.swagger !== undefined) {
		throw new UsageError(`oat: ${source} is Swagger ${String(doc.swagger)}; ${READS} — convert it first`)
	}
	if (typeof doc.openapi !== "string") {
		throw new Error(`oat: ${source} has no "openapi" version field; ${READS}`)
	}
	const minor = /^3\.(\d+)/.exec(doc.openapi)?.[1]
	if (minor === undefined || Number(minor) > 2) {
		throw new UsageError(`oat: ${source} is OpenAPI ${doc.openapi}; ${READS}`)
	}
}
