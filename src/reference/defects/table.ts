/**
 * Defects the reference backend can be told to exhibit.
 *
 * Each one is a real bug seen in production APIs, reduced to its smallest form. The conformance
 * suite switches them on individually and asserts oat reports exactly that defect and nothing
 * else — which is what turns "oat is smart" into precision and recall numbers.
 *
 * Keep the implementations naive and obvious. If the reference backend grows clever it starts
 * encoding the same assumptions oat does, and the two drift together into agreeing on nonsense.
 */

import { CATALOG_DEFECTS } from "./catalog.ts"
import { COMPOSITION_DEFECTS } from "./composition.ts"
import { CORE_DEFECTS } from "./core.ts"
import { QUERY_DEFECTS } from "./query.ts"
import { RECORD_DEFECTS } from "./records.ts"
import { SECURITY_DEFECTS } from "./security.ts"

/* The families in the table's order: every reader of the names (the matrix, the docs, the goldens) sees this order. */
export const DEFECTS: Readonly<
	typeof CORE_DEFECTS &
		typeof COMPOSITION_DEFECTS &
		typeof QUERY_DEFECTS &
		typeof RECORD_DEFECTS &
		typeof CATALOG_DEFECTS &
		typeof SECURITY_DEFECTS
> = {
	...CORE_DEFECTS,
	...COMPOSITION_DEFECTS,
	...QUERY_DEFECTS,
	...RECORD_DEFECTS,
	...CATALOG_DEFECTS,
	...SECURITY_DEFECTS,
}

export type DefectName = keyof typeof DEFECTS

export function isDefectName(value: string): value is DefectName {
	return Object.hasOwn(DEFECTS, value)
}
