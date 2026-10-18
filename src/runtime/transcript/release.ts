/** Drops the live bodies of an exchange the transcript keeps, once the request is over. */

import type { Exchange } from "../exchange.ts"
import type { Redactor } from "../../security/redact.ts"
import { compactRequestBody } from "./compact-request.ts"
import { compactResponseBody } from "./compact-response.ts"

/** Drop live request/response payloads on an exchange already pushed to the transcript. */
export async function releaseTranscriptBodies(exchange: Exchange, redactor: Redactor): Promise<void> {
	exchange.requestBody = await compactRequestBody(exchange.requestBody, redactor, {
		bytes: exchange.requestBytes,
		digest: exchange.requestDigest,
	})
	exchange.responseBody = await compactResponseBody(exchange.responseBody, exchange.responseHeaders, {
		bytes: exchange.responseBytes,
		digest: exchange.responseDigest,
	})
}
