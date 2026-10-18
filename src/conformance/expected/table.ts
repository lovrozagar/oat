import type { DefectName } from "../../reference/defects.ts"
import type { FindingId } from "../../runtime/check-ids.ts"
import { COMPOSITION_EXPECTED } from "./composition.ts"
import { CONFORMANCE_EXPECTED } from "./conformance.ts"
import { CONSISTENCY_EXPECTED } from "./consistency.ts"
import { FILTER_EXPECTED } from "./filter.ts"
import { ISOLATION_EXPECTED } from "./isolation.ts"
import { OTHER_EXPECTED } from "./other.ts"
import { PAGINATION_EXPECTED } from "./pagination.ts"
import { SORT_EXPECTED } from "./sort.ts"
import { VALIDATION_EXPECTED } from "./validation.ts"
import { WRITE_EXPECTED } from "./write.ts"

/**
 * Which check each defect must trip.
 *
 * The first id is the primary — the diagnosis oat is required to reach. Any further ids are
 * *acceptable* consequences: one defect can legitimately violate several properties at once, and
 * calling those false positives would push oat toward under-reporting real problems.
 */
export const EXPECTED: Record<DefectName, FindingId | FindingId[]> = {
	...COMPOSITION_EXPECTED,
	...CONFORMANCE_EXPECTED,
	...CONSISTENCY_EXPECTED,
	...FILTER_EXPECTED,
	...ISOLATION_EXPECTED,
	...OTHER_EXPECTED,
	...PAGINATION_EXPECTED,
	...SORT_EXPECTED,
	...VALIDATION_EXPECTED,
	...WRITE_EXPECTED,
}
