/**
 * Single source of truth for the reference backend: the server implements these descriptors and
 * the OpenAPI document is generated from them. Keeping both sides derived from one definition
 * mirrors how real backends emit their spec, and means a drift between spec and behaviour has to
 * be introduced deliberately (as a defect) rather than by accident.
 */

export interface FieldDef {
	name: string
	type: "string" | "number" | "integer" | "boolean"
	nullable?: boolean
	enum?: readonly string[]
	maxLength?: number
	/** Server-assigned; never accepted from a client. */
	generated?: boolean
	/** Present in responses but rejected as a write after creation. */
	immutable?: boolean
	/** Accepted at create but not at update. */
	createOnly?: boolean
	required?: boolean
	filterable?: boolean
	sortable?: boolean
	searchable?: boolean
}

export interface EntityDef {
	name: string
	plural: string
	/** Path template relative to the API root, with `{param}` placeholders. */
	collectionPath: string
	itemPath: string
	itemParam: string
	/** Path parameters that must be resolved from an ancestor. */
	parents: string[]
	identity: string
	softDeleteField?: string
	fields: FieldDef[]
	defaultLimit: number
	maxLimit: number
}

const TIMESTAMPS: FieldDef[] = [
	{ filterable: true, generated: true, name: "created_at", sortable: true, type: "integer" },
	{ filterable: true, generated: true, name: "updated_at", sortable: true, type: "integer" },
]

export const TABLE: EntityDef = {
	collectionPath: "/v1/projects/{project_id}/tables",
	defaultLimit: 20,
	fields: [
		{ generated: true, immutable: true, name: "id", required: true, sortable: true, filterable: true, type: "string" },
		{ generated: true, immutable: true, name: "project_id", required: true, filterable: true, type: "string" },
		{
			filterable: true,
			maxLength: 128,
			name: "name",
			required: true,
			searchable: true,
			sortable: true,
			type: "string",
		},
		{ filterable: true, name: "slug", searchable: true, sortable: true, maxLength: 64, type: "string" },
		{
			enum: ["active", "draft", "archived"],
			filterable: true,
			name: "status",
			sortable: true,
			type: "string",
		},
		{ filterable: true, name: "position", sortable: true, type: "integer" },
		{ filterable: true, maxLength: 256, name: "description", nullable: true, sortable: true, type: "string" },
		...TIMESTAMPS,
		{ filterable: true, generated: true, name: "deleted_at", nullable: true, sortable: true, type: "integer" },
	],
	identity: "id",
	itemParam: "table_id",
	itemPath: "/v1/projects/{project_id}/tables/{table_id}",
	maxLimit: 100,
	name: "table",
	parents: ["project_id"],
	plural: "tables",
	softDeleteField: "deleted_at",
}

export const ROW: EntityDef = {
	collectionPath: "/v1/projects/{project_id}/tables/{table_id}/rows",
	defaultLimit: 20,
	fields: [
		{ generated: true, immutable: true, name: "id", required: true, sortable: true, filterable: true, type: "string" },
		{ generated: true, immutable: true, name: "table_id", required: true, filterable: true, type: "string" },
		{
			filterable: true,
			maxLength: 128,
			name: "label",
			required: true,
			searchable: true,
			sortable: true,
			type: "string",
		},
		{ filterable: true, name: "amount", sortable: true, type: "number" },
		{ filterable: true, name: "note", nullable: true, searchable: true, sortable: true, maxLength: 256, type: "string" },
		{ filterable: true, name: "active", sortable: true, type: "boolean" },
		...TIMESTAMPS,
	],
	identity: "id",
	itemParam: "row_id",
	itemPath: "/v1/projects/{project_id}/tables/{table_id}/rows/{row_id}",
	/* Deliberately below the default cohort size so the cap is observable at all — a limit
	 * ceiling no request can reach cannot be tested. */
	maxLimit: 5,
	name: "row",
	parents: ["project_id", "table_id"],
	plural: "rows",
}

export const ENTITIES: readonly EntityDef[] = [TABLE, ROW]

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
