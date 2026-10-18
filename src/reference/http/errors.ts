/** How the reference refuses a request, and the answer every failure becomes. */

import { messageOf } from "../../errors/message.ts"
import type { DefectSet } from "../defects/defect-set.ts"
import { SqlError } from "../store-api.ts"
import { type ReferenceResponse, respond } from "./wire.ts"

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly errorKey: string,
		message: string,
	) {
		super(message)
	}
}

/** The answer a failed request gets: a refusal as itself, a bad filter as a 400, anything else as a 500. */
export function errorResponse(error: unknown, defects: DefectSet): ReferenceResponse {
	if (error instanceof HttpError) {
		if (defects.has("ERROR_SCHEMA_DRIFT"))
			return respond(error.status, { detail: error.message, error: error.errorKey })
		return failure(error.status, error.errorKey, error.message)
	}
	if (error instanceof SqlError) {
		/* Correct behaviour is a 400. The defect lets the filter parser's own exception escape, which
		 * the transport surfaces as a 500 — validation confused with crashing. */
		if (defects.has("ERROR_500_ON_BAD_FILTER") && error.code === "invalid_filter") {
			return failure(500, "internal_error", error.message)
		}
		return failure(400, "invalid_input", error.message)
	}
	return failure(500, "internal_error", messageOf(error))
}

function failure(status: number, errorKey: string, message: string): ReferenceResponse {
	return respond(status, { error_key: errorKey, message, status, success: false })
}
