export type FieldType = "string" | "integer" | "number" | "boolean"

export interface Field {
	name: string
	type: FieldType
	required?: boolean
	nullable?: boolean
	generated?: boolean
	immutable?: boolean
	filterable?: boolean
	sortable?: boolean
	searchable?: boolean
	enum?: readonly string[]
	maxLength?: number
}

export interface Derived {
	name: string
	/** Child entity whose rows are counted. */
	from: string
	op: "count"
}

export interface Entity {
	name: string
	plural: string
	identity: string
	/** Parent entity name, if nested. */
	parent?: string
	fields: Field[]
	derived?: Derived[]
	softDelete?: boolean
	invite?: boolean
	maxLimit?: number
}

export type Defect =
	| "stale-parent"
	| "drop-filter"
	| "filter-after-page"
	| "ignore-tenant-get"
	| "overclaim-filter"
	| "ignore-cursor"
	| "invite-noop"
	| "clobber-patch"
	| "list-tombstone"
	| "invert-rank"
	| "filter-bypass-tenant"
	| "lie-has-more"
	| "ignore-max-limit"
	| "drop-search"
	| "drop-select"
	| "drop-sort"
	| "drop-idempotency"
	| "accept-immutable"
	| "skip-enum"
	| "skip-max-length"
	| "skip-required"
	| "revoke-noop"
	| "ignore-page"
	| "oracle-status"
	| "unescape-like"
	| "async-stall"
	| "effect-noop"
	| "overclaim-sort"
	| "overclaim-select"
	| "omit-receipt-id"
	| "lie-count"
	| "widen-patch"
	| "accept-unknown-filter"
	| "ignore-neq"
	| "and-as-or"
	| "or-as-and"
	| "text-compare"
	| "ignore-limit"
	| "drop-create-field"
	| "create-200"
	| "delete-missing-ok"
	| "skip-content-type"
	| "filter-500"
	| "wrong-error-shape"

export interface QueryNames {
	filter: string
	order: string
	select: string
	search: string
	limit: string
}

export interface World {
	id: string
	title: string
	entities: Entity[]
	defects?: Defect[]
	queryNames?: QueryNames
	/** Extra start/poll surface used to plant x-async / x-effects. */
	jobs?: boolean
}

export function hasDefect(world: World, defect: Defect): boolean {
	return world.defects?.includes(defect) === true
}

export function entityByName(world: World, name: string): Entity {
	const found = world.entities.find((item) => item.name === name)
	if (found === undefined) throw new Error(`unknown entity ${name}`)
	return found
}

export function ancestors(world: World, entity: Entity): Entity[] {
	const chain: Entity[] = []
	let current = entity.parent
	while (current !== undefined) {
		const parent = entityByName(world, current)
		chain.unshift(parent)
		current = parent.parent
	}
	return chain
}

export function parentIdField(entity: Entity): string | null {
	return entity.parent === undefined ? null : `${entity.parent}_id`
}

export function collectionPath(world: World, entity: Entity): string {
	let path = "/v1/orgs/{org_id}"
	for (const ancestor of ancestors(world, entity)) {
		path += `/${ancestor.plural}/{${ancestor.name}_id}`
	}
	return `${path}/${entity.plural}`
}

export function itemPath(world: World, entity: Entity): string {
	return `${collectionPath(world, entity)}/{${entity.name}_id}`
}

export function allColumns(entity: Entity): string[] {
	const cols = ["id", "org_id"]
	const parent = parentIdField(entity)
	if (parent !== null) cols.push(parent)
	for (const field of entity.fields) cols.push(field.name)
	for (const derived of entity.derived ?? []) cols.push(derived.name)
	cols.push("created_at", "updated_at")
	if (entity.softDelete === true) cols.push("deleted_at")
	return cols
}

export function numericFields(entity: Entity): string[] {
	const names = ["created_at", "updated_at"]
	if (entity.softDelete === true) names.push("deleted_at")
	for (const field of entity.fields) {
		if (field.type === "integer" || field.type === "number") names.push(field.name)
	}
	for (const derived of entity.derived ?? []) names.push(derived.name)
	return names
}

export function writableFields(entity: Entity): string[] {
	return entity.fields.filter((f) => f.generated !== true).map((f) => f.name)
}
