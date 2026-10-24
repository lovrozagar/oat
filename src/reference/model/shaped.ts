import { ENTITIES } from "./entities.ts"
import { renameIdentity } from "./identity.ts"
import { TABLE } from "./table.ts"
import { guardStrings } from "./string-guard.ts"
import { shapeTable } from "./table-shape.ts"
import type { EntityDef, EntityShape, FieldDef } from "./types.ts"

/**
 * The entities as a given shape serves them.
 *
 * A shape changes what the records look like — the identifier format, extra fields a real schema
 * would carry — without changing what a correct backend does with them. Copies are returned, so
 * one server's shape never leaks into another's.
 */
export function shapedEntities(shape: EntityShape): EntityDef[] {
	const linkParams = new Set(ENTITIES.map((entity) => entity.itemParam))
	return ENTITIES.map((original) => {
		/* The async job keeps its own identity: its receipt and poll route are keyed on `id`. */
		const renamed = original.name === "job" ? undefined : shape.identityField
		const entity = renamed === undefined || renamed === original.identity ? original : renameIdentity(original, renamed)
		const fields = entity.fields.map((field) =>
			field.name === entity.identity || linkParams.has(field.name) ? idField(field, shape.ids) : { ...field },
		)
		const unique = entity.name === TABLE.name ? shapeTable(entity, fields, shape) : entity.unique
		const served = shape.stringGuard === true ? guardStrings(fields) : fields
		return { ...entity, fields: served, ...(unique === undefined ? {} : { unique }) }
	})
}

/* An identity, or a parent's identity a path carries, in the shape's identifier format. */
function idField(field: FieldDef, ids: EntityShape["ids"]): FieldDef {
	if (ids === "uuid") return { ...field, format: "uuid", type: "string" }
	if (ids === "integer") return { ...field, type: "integer" }
	return field
}
