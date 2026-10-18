import type { DefectSet } from "../defects/defect-set.ts"
import { fieldsWhere } from "../model/fields.ts"
import type { EntityDef } from "../model/types.ts"
import type { FilterNode, SearchMode } from "../query-types.ts"

/**
 * Search tokens: every token must occur, case-insensitively, in some searchable field — as a
 * substring under `contains`, at the start of the value under `prefix`. A blank query matches
 * everything.
 */
export function parseSearch(q: string, entity: EntityDef, defects: DefectSet, mode: SearchMode): FilterNode | null {
	const split = q
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0)
	const fields = fieldsWhere(entity, "searchable")
	if (split.length === 0) return defects.has("SEARCH_EMPTY_MATCHES_NONE") ? { kind: "const", value: false } : null
	if (fields.length === 0) return null
	const tokens = defects.has("SEARCH_ONLY_FIRST_TOKEN") ? split.slice(0, 1) : split
	const caseSensitive = defects.has("SEARCH_CASE_SENSITIVE")
	return {
		children: tokens.map((token) => ({ caseSensitive, fields, kind: "search", mode, token })),
		kind: "and",
	}
}
