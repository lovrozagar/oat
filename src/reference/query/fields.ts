import type { DefectSet } from "../defects/defect-set.ts"
import { fieldsWhere, OVERCLAIMED_FIELD } from "../model/fields.ts"
import type { EntityDef, FieldDef } from "../model/types.ts"

export function fieldOf(entity: EntityDef, name: string): FieldDef | undefined {
	return entity.fields.find((field) => field.name === name)
}

export function filterableFields(entity: EntityDef, defects: DefectSet): string[] {
	const declared = fieldsWhere(entity, "filterable")
	/* Under the overclaim the backend refuses a field the document still declares filterable. The
	 * backend is not wrong to refuse — the document is wrong to promise. */
	return defects.has("SPEC_OVERCLAIMS_FILTERABLE") ? declared.filter((f) => f !== OVERCLAIMED_FIELD) : declared
}

export function sortableFields(entity: EntityDef, defects: DefectSet): string[] {
	const declared = fieldsWhere(entity, "sortable")
	return defects.has("SPEC_OVERCLAIMS_SORTABLE") ? declared.filter((f) => f !== OVERCLAIMED_FIELD) : declared
}

export function isNumeric(field: FieldDef | undefined): boolean {
	return field?.type === "integer" || field?.type === "number"
}
