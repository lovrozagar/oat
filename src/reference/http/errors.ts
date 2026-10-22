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

/**
 * A precondition the request names does not hold: an RFC 9457 problem detail. It is answered here,
 * not as an `HttpError`, so what reshapes every other refusal leaves it as it is.
 */
export function preconditionFailed(defects: DefectSet, detail: string): ReferenceResponse {
	const problem = {
		detail,
		status: defects.has("PROBLEM_JSON_MALFORMED") ? 400 : 412,
		title: "Precondition Failed",
		type: "about:blank",
	}
	return respond(412, problem, { "content-type": "application/problem+json" })
}

function failure(status: number, errorKey: string, message: string): ReferenceResponse {
	return respond(status, { error_key: errorKey, message, status, success: false })
}
