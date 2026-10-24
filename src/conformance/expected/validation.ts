import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects with a row in the validation family; a name that is not a defect falls out and fails its row. */
type ValidationDefect = Extract<
	DefectName,
	| "ENUM_NOT_VALIDATED"
	| "MAXLENGTH_NOT_VALIDATED"
	| "REQUIRED_NOT_VALIDATED"
	| "CONTENT_TYPE_NOT_ENFORCED"
	| "WRITE_BODY_NOT_VALIDATED"
>

/** The defects whose primary check is in the validation family, and the check each must trip. */
export const VALIDATION_EXPECTED: Record<ValidationDefect, FindingId | FindingId[]> = {
	/* What the create let through is stored, and the listing then serves a value its schema forbids. */
	ENUM_NOT_VALIDATED: ["validation.enum-enforced", "schema.read-response-matches-document"],
	MAXLENGTH_NOT_VALIDATED: ["validation.max-length-enforced", "schema.read-response-matches-document"],
	/* The create's required check is the replacing update's too (validateBody, mode "replace"): under the
	 * put-update shape, a PUT update missing a required field is applied, which the update check sees. */
	REQUIRED_NOT_VALIDATED: ["validation.required-enforced", "request.invalid-body-refused"],
	CONTENT_TYPE_NOT_ENFORCED: "validation.content-type-enforced",
	WRITE_BODY_NOT_VALIDATED: "request.invalid-body-refused",
}
