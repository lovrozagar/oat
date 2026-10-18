import { TIMESTAMPS } from "./timestamps.ts"
import type { EntityDef } from "./types.ts"

/** A row of a table: numbers, booleans, a nullable note and an array, under a small page ceiling. */
export const ROW: EntityDef = {
	collectionPath: "/v1/projects/{project_id}/tables/{table_id}/rows",
	defaultLimit: 20,
	defaultOrder: "created_at.desc",
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
		{
			filterable: true,
			name: "note",
			nullable: true,
			searchable: true,
			sortable: true,
			maxLength: 256,
			type: "string",
		},
		{ filterable: true, name: "active", sortable: true, type: "boolean" },
		/* An array, so set membership (`contains`) has something real to test. The elements are
		 * chosen so one is a prefix of another: matching by substring is then visibly wrong. */
		{ filterable: true, items: ["red", "redwood", "blue", "green"], name: "tags", type: "array" },
		...TIMESTAMPS,
	],
	identity: "id",
	itemParam: "row_id",
	relations: { table: { entity: "table", fields: ["name", "status"], via: "table_id" } },
	itemPath: "/v1/projects/{project_id}/tables/{table_id}/rows/{row_id}",
	/* Deliberately below the default cohort size so the cap is observable at all — a limit
	 * ceiling no request can reach cannot be tested. */
	maxLimit: 5,
	name: "row",
	parents: ["project_id", "table_id"],
	plural: "rows",
}
