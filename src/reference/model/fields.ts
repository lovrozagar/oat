import type { EntityDef, FieldDef } from "./types.ts"

/**
 * The field a spec-overclaim defect withholds from the backend while the document still lists it.
 *
 * Chosen as a field every entity has and that no other defect touches, so the overclaim is the
 * only difference between what the document promises and what the backend accepts.
 */
export const OVERCLAIMED_FIELD = "created_at"

export function fieldsWhere(entity: EntityDef, key: keyof FieldDef): string[] {
	return entity.fields.filter((f) => f[key] === true).map((f) => f.name)
}

export function writableFields(entity: EntityDef, phase: "create" | "update"): FieldDef[] {
	return entity.fields.filter((f) => {
		if (f.generated === true) return false
		if (phase === "update" && (f.immutable === true || f.createOnly === true)) return false
		return true
	})
}
