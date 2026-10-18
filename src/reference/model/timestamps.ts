import type { FieldDef } from "./types.ts"

/** The creation and update instants every entity carries; the server sets both. */
export const TIMESTAMPS: FieldDef[] = [
	{ filterable: true, generated: true, name: "created_at", sortable: true, type: "integer" },
	{ filterable: true, generated: true, name: "updated_at", sortable: true, type: "integer" },
]
