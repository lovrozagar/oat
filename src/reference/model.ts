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
	/** Optional closed filter/select catalog for conformance of declared-or-skip checks. */
	filterCatalog?: {
		emptyIn?: "reject" | "match-none"
		maxInValues?: number
		maxFilterConditions?: number
		opsByField?: Record<string, readonly string[]>
		selectUnknown?: "reject" | "ignore"
		aliases?: Record<string, string>
	}
	/** Column sets that must stay unique. Emitted as `x-unique` and enforced as HTTP 409. */
	unique?: string[][]
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

/**
 * An asynchronous job. Present so the async lifecycle — receipt, poll, terminal state — has
 * something to exercise; extraction, export and batch APIs are all shaped this way.
 */
export const JOB: EntityDef = {
	collectionPath: "/v1/projects/{project_id}/jobs",
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
		/* A second freely-writable string, purely so the concurrency check has two independent
		 * fields to race on. With only `name` writable it could never establish that two patches
		 * to *different* fields both survive, and it stood down on every run. */
		{
			filterable: true,
			maxLength: 256,
			name: "note",
			nullable: true,
			searchable: true,
			sortable: true,
			type: "string",
		},
		/*
		 * A low-cardinality field the *client* sets.
		 *
		 * Every other field on this entity is either unique per record or server-generated, which
		 * left no value shared by some records but not all — so any property asserted over a
		 * proper subset (a filter that matches several rows and excludes others) had nothing to
		 * work with and stood down. Real collections always have a repeated dimension; a fixture
		 * without one silently narrows what can be tested.
		 */
		{
			enum: ["export", "import", "sync"],
			filterable: true,
			name: "kind",
			sortable: true,
			type: "string",
		},
		{
			enum: ["pending", "running", "complete", "failed"],
			filterable: true,
			generated: true,
			name: "status",
			sortable: true,
			type: "string",
		},
		{ filterable: true, generated: true, name: "progress", sortable: true, type: "integer" },
		...TIMESTAMPS,
	],
	identity: "id",
	itemParam: "job_id",
	itemPath: "/v1/projects/{project_id}/jobs/{job_id}",
	maxLimit: 100,
	name: "job",
	parents: ["project_id"],
	plural: "jobs",
}

export const ENTITIES: readonly EntityDef[] = [TABLE, ROW, JOB]

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
