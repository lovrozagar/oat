import { PHONE_PATTERN } from "./string-guard.ts"
import type { EntityDef, EntityShape, FieldDef } from "./types.ts"

/**
 * Lays a shape's table changes over `fields`, in place, and returns the unique sets the table
 * then keeps. `fields` holds the table's identity field and its `slug`: every table does.
 */
export function shapeTable(entity: EntityDef, fields: FieldDef[], shape: EntityShape): string[][] | undefined {
	let unique = entity.unique
	const clientIds = shape.clientIds
	if (clientIds !== undefined) {
		/* The client names the table: its id is a bounded, required, unique create field. */
		const at = fields.findIndex((field) => field.name === entity.identity)
		fields[at] = {
			...(fields[at] as FieldDef),
			generated: false,
			maximum: clientIds.max,
			minimum: clientIds.min,
			required: true,
			type: "integer",
		}
		unique = [...(entity.unique as string[][]), [entity.identity]]
	}
	if (shape.tableKey === "slug") {
		/* The server derives it from the name; it is as long as a name may be. */
		const at = fields.findIndex((field) => field.name === "slug")
		fields[at] = { ...(fields[at] as FieldDef), generated: true, maxLength: 128, required: true }
		/* Names may repeat across projects and the document declares nothing unique: the
		 * server refuses only a slug its project already holds. */
		unique = []
	}
	fields.push(...extraFields(shape))
	return unique
}

/** The fields a shape adds to the table, in the order the document lists them. */
function extraFields(shape: EntityShape): FieldDef[] {
	return [
		...(shape.writeOnlyField === true
			? [{ maxLength: 64, name: "secret", required: true, type: "string", writeOnly: true } satisfies FieldDef]
			: []),
		...(shape.richSchema === true ? richFields() : []),
		...(shape.stringGuard === true
			? [
					{
						maxLength: 15,
						minLength: 7,
						name: "phone",
						nullable: true,
						patterns: [PHONE_PATTERN],
						type: "string",
					} satisfies FieldDef,
				]
			: []),
		...(shape.largeRecords === true ? [{ generated: true, name: "padding", type: "string" } satisfies FieldDef] : []),
		...(shape.specLayout === true
			? [{ generated: true, name: "tree", nullable: true, ref: "TreeNode", type: "object" } satisfies FieldDef]
			: []),
	]
}

/* Required date-time, a bounded number, a `const`, and one component schema used twice. */
function richFields(): FieldDef[] {
	return [
		{ format: "date-time", name: "due_at", required: true, type: "string" },
		{ maximum: 10, minimum: 1, multipleOf: 0.5, name: "weight", required: true, type: "number" },
		{ const: "v1", name: "schema_version", required: true, type: "string" },
		{ name: "start", ref: "Point", required: true, type: "object" },
		{ name: "end", ref: "Point", required: true, type: "object" },
	]
}
