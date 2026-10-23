import type { DefectSet } from "../defects/defect-set.ts"
import { OVERCLAIMED_FIELD } from "../model/fields.ts"
import type { EntityDef } from "../model/types.ts"
import { SqlError } from "../store-api.ts"

/** `relation(field,field)` inside a sparse fieldset. Both groups take part in every match. */
export const NESTED: RegExp = /^([A-Za-z_][\w]*)\(([^()]*)\)$/

/** No sparse fieldset at all: every field is served. */
export function wholeRow(select: string | undefined): boolean {
	return select === undefined || select === "" || select === "*"
}

/** Splits a sparse fieldset on top-level commas, so `id,table(name,status)` is two entries. */
export function selectEntries(select: string): string[] {
	const out: string[] = []
	let depth = 0
	let current = ""
	for (const ch of select) {
		if (ch === "(") depth++
		if (ch === ")") depth--
		if (ch === "," && depth === 0) {
			out.push(current.trim())
			current = ""
		} else current += ch
	}
	out.push(current.trim())
	return out.filter(Boolean)
}

/** The fields a nested entry names: `name,status` of `table(name,status)`. */
export function nestedFields(list: string): string[] {
	return list.split(",").map((field) => field.trim())
}

/** Validates a sparse fieldset against the entity before any row is read. */
export function checkSelect(select: string | undefined, entity: EntityDef, defects: DefectSet): void {
	if (wholeRow(select)) return
	for (const entry of selectEntries(select as string)) {
		const nested = NESTED.exec(entry)
		if (nested !== null) {
			const relation = entity.relations?.[nested[1] as string]
			const fields = nestedFields(nested[2] as string)
			if (relation === undefined || fields.some((field) => !relation.fields.includes(field))) {
				throw new SqlError("invalid_select", `"${entry}" is not a selectable relation`)
			}
			continue
		}
		if (defects.has("SPEC_OVERCLAIMS_SELECTABLE") && entry === OVERCLAIMED_FIELD) {
			throw new SqlError("invalid_select", `field "${OVERCLAIMED_FIELD}" is not selectable`)
		}
		const known = entity.fields.some((field) => field.name === entry)
		if (!known && entity.filterCatalog?.selectUnknown === "reject" && !defects.has("SELECT_UNKNOWN_IGNORED")) {
			throw new SqlError("invalid_select", `field "${entry}" is not selectable`)
		}
	}
}
