import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects whose primary check is in the conformance family, and the check each must trip. */
export const CONFORMANCE_EXPECTED = {
	PUBLIC_GET_NOT_SUCCESS: "response.public-get-returns-success",
	TOKEN_EXPIRY_AS_STRING: "response.contract-call",
	DISCRIMINATOR_BRANCH_WRONG: "response.contract-call",
	RESPONSE_STATUS_UNDECLARED: "response.status-is-documented",
	ERROR_SCHEMA_DRIFT: "schema.error-response-matches-document",
	PROBLEM_JSON_MALFORMED: "schema.problem-json-shape",
	RESPONSE_SCHEMA_DRIFT: "schema.success-response-matches-document",
	/* The 500 is a crash, and one the reference document never lists, which is a spec finding too. */
	ACTION_CRASHES: ["response.no-server-error", "response.status-is-documented"],
} satisfies Partial<Record<DefectName, FindingId | FindingId[]>>
