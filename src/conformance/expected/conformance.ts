import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects with a row in the conformance family; a name that is not a defect falls out and fails its row. */
type ConformanceDefect = Extract<
	DefectName,
	| "PUBLIC_GET_NOT_SUCCESS"
	| "TOKEN_EXPIRY_AS_STRING"
	| "DISCRIMINATOR_BRANCH_WRONG"
	| "RESPONSE_STATUS_UNDECLARED"
	| "ERROR_SCHEMA_DRIFT"
	| "PROBLEM_JSON_MALFORMED"
	| "RESPONSE_SCHEMA_DRIFT"
	| "READ_BODY_DIVERGES"
	| "WRITE_ONLY_LEAKED"
	| "ACTION_CRASHES"
>

/** The defects whose primary check is in the conformance family, and the check each must trip. */
export const CONFORMANCE_EXPECTED: Record<ConformanceDefect, FindingId | FindingId[]> = {
	PUBLIC_GET_NOT_SUCCESS: "response.public-get-returns-success",
	TOKEN_EXPIRY_AS_STRING: "response.contract-call",
	DISCRIMINATOR_BRANCH_WRONG: "response.contract-call",
	RESPONSE_STATUS_UNDECLARED: "response.status-is-documented",
	ERROR_SCHEMA_DRIFT: "schema.error-response-matches-document",
	PROBLEM_JSON_MALFORMED: "schema.problem-json-shape",
	/* Every record answer carries the undeclared fields: the create's, and the reads' too. */
	RESPONSE_SCHEMA_DRIFT: ["schema.success-response-matches-document", "schema.read-response-matches-document"],
	READ_BODY_DIVERGES: "schema.read-response-matches-document",
	/*
	 * A password the item read answers. The reference's record schemas are closed, and a writeOnly
	 * property is no part of a response, so the read's schema check sees an undeclared field too.
	 */
	WRITE_ONLY_LEAKED: ["response.write-only-not-returned", "schema.read-response-matches-document"],
	/* The 500 is a crash, and one the reference document never lists, which is a spec finding too. */
	ACTION_CRASHES: ["response.no-server-error", "response.status-is-documented"],
}
