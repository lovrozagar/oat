/*
 * A probe is deliberately abnormal: sent with no credential, a forged one, or one made to be
 * refused. What it is answered is the security checks' to judge. Judges whose verdict is "the answer
 * differs from the document" leave it alone: a correct 401 to an anonymous probe, on an API that
 * documents no 401, is noise of oat's own making. Every other judge still reads it, so a 5xx a probe
 * provokes is reported: a judge not named here judges probes by default.
 */

import type { CheckId } from "./check-ids.ts"
import type { Exchange } from "./exchange.ts"

/** The documentation-conformance judges: each compares an answer with what the document says. */
export const DOCUMENTATION_JUDGES = [
	"create.status-matches-document",
	"response.contract-call",
	"response.status-is-documented",
	"schema.error-response-matches-document",
	"schema.success-response-matches-document",
] as const satisfies readonly CheckId[]

/** Whether the exchange was a probe: sent as one, or with a forged credential. */
export function isProbeExchange(exchange: Pick<Exchange, "probe" | "forged">): boolean {
	return exchange.probe === true || exchange.forged === true
}

/** Whether `judge` grades `exchange`: anything but a probe, unless the judge is not a documentation judge. */
export function judges(judge: CheckId, exchange: Pick<Exchange, "probe" | "forged">): boolean {
	const documentation: readonly string[] = DOCUMENTATION_JUDGES
	return !isProbeExchange(exchange) || !documentation.includes(judge)
}
