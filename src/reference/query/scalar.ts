import type { Scalar } from "../query-types.ts"

/* The comparisons the in-memory evaluation and ordering share. */

export function isNull(value: unknown): boolean {
	return value === null || value === undefined
}

export function compareScalar(a: unknown, b: unknown, asText: boolean): number {
	if (!asText && typeof a === "number" && typeof b === "number") return a - b
	if (!asText && typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
	const as = String(a)
	const bs = String(b)
	return as < bs ? -1 : as > bs ? 1 : 0
}

export function equal(a: unknown, b: Scalar, asText: boolean): boolean {
	if (asText) return String(a) === String(b)
	return a === b
}
