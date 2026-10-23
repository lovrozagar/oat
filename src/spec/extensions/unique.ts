/** `x-unique`: the column sets an entity keeps unique, for the unique-conflict checks. */

import type { RawOf } from "../../config/types/raw.ts"
import { isObject } from "../tags/checks.ts"
import type { OperationObject } from "../types.ts"
import type { GapCollector } from "./gaps.ts"
import { ext } from "./tag.ts"

const MALFORMED = "x-unique is not a list of column sets; unique-conflict checks will not run"

const columns = (cols: string[]): string[] => cols.filter((col) => col !== "")

const allStrings = (items: unknown[]): items is string[] => items.every((item) => typeof item === "string")

/** The object form of one `x-unique` set. */
interface UniqueSetTag {
	columns: string[]
}

/** `null` means the item is malformed, not an empty set. */
function parseUniqueSet(item: unknown): string[] | null {
	if (Array.isArray(item)) return allStrings(item) ? columns(item) : null
	if (!isObject(item)) return null
	const set: RawOf<UniqueSetTag> = item
	return Array.isArray(set.columns) && allStrings(set.columns) ? columns(set.columns) : null
}

/**
 * `x-unique` — column sets that must stay unique.
 *
 * Accepted shapes:
 * - a list of column sets (`[["email"], ["workspace_id", "slug"]]`)
 * - `{ columns: [...] }` objects
 * - a single `string[]` meaning one set
 *
 * Each set is a non-empty list of column names; empty sets are dropped. Malformed / non-array
 * → `null` and a recorded gap (the check does not run). `[]` after filtering is explicit none
 * (check does not run). Missing tag → `null`, no gap — unique checks do not run.
 *
 * Uniqueness is never inferred from 409s, unique-looking names, or JSON Schema `uniqueItems`.
 */
export function readUnique(op: OperationObject, operationId?: string, gaps?: GapCollector): string[][] | null {
	const raw = ext(op, "x-unique")
	if (raw === undefined) return null
	if (!Array.isArray(raw)) {
		gaps?.record(operationId ?? "", "x-unique", MALFORMED)
		return null
	}
	if (raw.length === 0) return []

	if (allStrings(raw)) {
		const cols = columns(raw)
		return cols.length === 0 ? [] : [cols]
	}

	const sets: string[][] = []
	for (const item of raw) {
		const parsed = parseUniqueSet(item)
		if (parsed === null) {
			gaps?.record(operationId ?? "", "x-unique", MALFORMED)
			return null
		}
		if (parsed.length > 0) sets.push(parsed)
	}
	return sets
}

export function formatUniqueSets(sets: string[][] | null): string {
	if (sets === null) return "—"
	if (sets.length === 0) return "(none)"
	return sets.map((set) => `[${set.join(", ")}]`).join("; ")
}
