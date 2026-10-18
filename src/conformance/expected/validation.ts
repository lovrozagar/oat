import type { DefectName } from "../../reference/defects.ts"
import type { FindingId } from "../../runtime/check-ids.ts"

/** The defects whose primary check is in the validation family, and the check each must trip. */
export const VALIDATION_EXPECTED = {
	ENUM_NOT_VALIDATED: "validation.enum-enforced",
	MAXLENGTH_NOT_VALIDATED: "validation.max-length-enforced",
	REQUIRED_NOT_VALIDATED: "validation.required-enforced",
	CONTENT_TYPE_NOT_ENFORCED: "validation.content-type-enforced",
} satisfies Partial<Record<DefectName, FindingId | FindingId[]>>
