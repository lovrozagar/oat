import type { Collation, OrderTerm } from "../query-types.ts"
import { compareScalar, isNull } from "./scalar.ts"

type Row = Record<string, unknown>

/** Orders rows under the plan. Ties the plan leaves open keep their input order. */
export function compareRows(order: OrderTerm[], collation: Collation): (left: Row, right: Row) => number {
	return (left, right) => {
		for (const term of order) {
			const a = left[term.field]
			const b = right[term.field]
			const aNull = isNull(a)
			const bNull = isNull(b)
			if (aNull && bNull) continue
			if (aNull || bNull) return aNull === term.nullsFirst ? -1 : 1
			const delta =
				collation === "insensitive" && typeof a === "string" && typeof b === "string"
					? compareScalar(a.toLowerCase(), b.toLowerCase(), true)
					: compareScalar(a, b, term.asText)
			if (delta !== 0) return term.descending ? -delta : delta
		}
		return 0
	}
}
