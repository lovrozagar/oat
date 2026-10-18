import { describe, expect, it } from "vitest"
import { DEFECTS } from "../../reference/defects/table.ts"
import { COMPOSITION_EXPECTED } from "./composition.ts"
import { CONFORMANCE_EXPECTED } from "./conformance.ts"
import { CONSISTENCY_EXPECTED } from "./consistency.ts"
import { FILTER_EXPECTED } from "./filter.ts"
import { ISOLATION_EXPECTED } from "./isolation.ts"
import { OTHER_EXPECTED } from "./other.ts"
import { PAGINATION_EXPECTED } from "./pagination.ts"
import { SORT_EXPECTED } from "./sort.ts"
import { EXPECTED } from "./table.ts"
import { VALIDATION_EXPECTED } from "./validation.ts"
import { WRITE_EXPECTED } from "./write.ts"

const FAMILIES = [
	COMPOSITION_EXPECTED,
	CONFORMANCE_EXPECTED,
	CONSISTENCY_EXPECTED,
	FILTER_EXPECTED,
	ISOLATION_EXPECTED,
	OTHER_EXPECTED,
	PAGINATION_EXPECTED,
	SORT_EXPECTED,
	VALIDATION_EXPECTED,
	WRITE_EXPECTED,
]

describe("EXPECTED", () => {
	it("has a row for every defect", () => {
		expect(Object.keys(EXPECTED).toSorted()).toEqual(Object.keys(DEFECTS).toSorted())
	})

	it("takes each defect from exactly one family", () => {
		const keys = FAMILIES.flatMap((family) => Object.keys(family))
		expect(keys).toHaveLength(new Set(keys).size)
		expect(keys).toHaveLength(Object.keys(EXPECTED).length)
	})
})
