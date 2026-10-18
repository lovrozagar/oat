import { TIMESTAMPS } from "./timestamps.ts"
import type { EntityDef } from "./types.ts"

/** A project's table: the root entity every tenant creates first. */
export const TABLE: EntityDef = {
	collectionPath: "/v1/projects/{project_id}/tables",
	defaultLimit: 20,
	defaultOrder: "created_at.desc",
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
		/*
		 * Derived from another entity: the number of rows this table holds.
		 *
		 * Its purpose is to make `x-invalidate` mean something testable. Without a field whose
		 * value depends on a *different* entity's writes, "creating a row invalidates the tables
		 * listing" is a claim no observation can contradict.
		 */
		{ filterable: true, generated: true, name: "row_count", sortable: true, type: "integer" },
	],
	identity: "id",
	itemParam: "table_id",
	itemPath: "/v1/projects/{project_id}/tables/{table_id}",
	maxLimit: 100,
	name: "table",
	parents: ["project_id"],
	plural: "tables",
	softDeleteField: "deleted_at",
	unique: [["name"]],
	filterCatalog: {
		aliases: { ne: "neq" },
		emptyIn: "match-none",
		maxFilterConditions: 20,
		maxInValues: 100,
		opsByField: {
			created_at: ["eq", "gt", "gte", "lt", "lte", "is"],
			deleted_at: ["eq", "is"],
			description: ["eq", "neq", "like", "ilike", "is"],
			id: ["eq", "neq", "ne", "in", "nin"],
			name: ["eq", "neq", "like", "ilike", "in"],
			position: ["eq", "neq", "gt", "gte", "lt", "lte", "in"],
			project_id: ["eq", "neq", "in"],
			row_count: ["eq", "gt", "gte", "lt", "lte"],
			slug: ["eq", "neq", "like", "ilike", "in"],
			status: ["eq", "neq", "in", "nin"],
			updated_at: ["eq", "gt", "gte", "lt", "lte", "is"],
		},
		selectUnknown: "reject",
	},
}
