import type { DefectName } from "../../reference/defects/table.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects whose primary check is in the validation family, and the check each must trip. */
export const VALIDATION_EXPECTED = {
	ENUM_NOT_VALIDATED: "validation.enum-enforced",
	MAXLENGTH_NOT_VALIDATED: "validation.max-length-enforced",
	/* The create's required check is the replacing update's too (validateBody, mode "replace"): under the
	 * put-update shape, a PUT update missing a required field is applied, which the update check sees. */
	REQUIRED_NOT_VALIDATED: ["validation.required-enforced", "request.invalid-body-refused"],
	CONTENT_TYPE_NOT_ENFORCED: "validation.content-type-enforced",
	WRITE_BODY_NOT_VALIDATED: "request.invalid-body-refused",
} satisfies Partial<Record<DefectName, FindingId | FindingId[]>>
