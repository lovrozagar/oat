/**
 * Single source of truth for the reference backend: the server implements these descriptors and
 * the OpenAPI document is generated from them. Keeping both sides derived from one definition
 * mirrors how real backends emit their spec, and means a drift between spec and behaviour has to
 * be introduced deliberately (as a defect) rather than by accident.
 */

export interface FieldDef {
	name: string
	type: "string" | "number" | "integer" | "boolean" | "object" | "array"
	/** For an array field: the values its elements may take. */
	items?: readonly string[]
	/** Declared `format`; the server rejects a value that does not match it. */
	format?: "date-time" | "uuid"
	minimum?: number
	maximum?: number
	multipleOf?: number
	const?: string
	/** Accepted on write and never returned. */
	writeOnly?: boolean
	/** For an object field: the component schema it references. */
	ref?: "Point" | "TreeNode"
	nullable?: boolean
	enum?: readonly string[]
	maxLength?: number
	/** Server-assigned; never accepted from a client. */
	generated?: boolean
	/** Present in responses but rejected as a write after creation. */
	immutable?: boolean
	/** Accepted at create but not at update. */
	createOnly?: boolean
	/** Only the highest rank may set it: emitted as `x-privileged`. */
	privileged?: boolean
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
	/** The entity has no list operation: its collection route takes a create alone, in the document and the server. */
	unlisted?: true
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
	/** The order a listing takes when the request names none, canonical `field.dir`. */
	defaultOrder: string
	/** Related records a sparse fieldset may embed: `table(name)` on a row. */
	relations?: Record<string, { entity: string; via: string; fields: readonly string[] }>
}

/** What a shape changes about the records themselves; see `ReferenceShape`. */
export interface EntityShape {
	ids?: "uuid" | "integer"
	writeOnlyField?: boolean
	richSchema?: boolean
	largeRecords?: boolean
	specLayout?: boolean
	clientIds?: { min: number; max: number }
	identityField?: string
	tableKey?: "slug"
}
