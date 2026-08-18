/**
 * Declared query capabilities — the catalog every list check consults.
 *
 * oat does not own which fields, operators, search modes, or nulls policies an API supports.
 * Those are declared on `x-query`, in `config.query` / `config.entities`, or harvested.
 * Missing capability → the check does not apply. New surface is never inferred.
 */

export const FILTER_OPS = [
	"eq",
	"ne",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"nin",
	"like",
	"ilike",
	"is",
	"contains",
] as const

export type FilterOp = (typeof FILTER_OPS)[number]
export const FIELD_TYPES = ["string", "number", "boolean", "date", "enum", "array"] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export type SearchMode = string
export type Nulls = "first" | "last"

/** Ops oat already wrote in 0.7.0. Implicit only when nothing declared a closed list. */
export const IMPLICIT_OPS: readonly FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "like"]
export const ORDERED_TYPES: ReadonlySet<FieldType> = new Set(["number", "date"])

export interface FilterableField {
	field: string
	type?: FieldType
	ops?: FilterOp[]
}

export interface SortableField {
	field: string
	type?: FieldType
	nulls?: Nulls[]
}

export interface SelectRelation {
	name: string
	fields: string[]
}

export interface FilterableFrom {
	operationId?: string
	route?: string
	path: string
	typePath?: string
	typeMap?: Record<string, FieldType>
}

export interface QueryCapabilities {
	filterable?: FilterableField[]
	sortable?: SortableField[]
	/** `null` is an explicit claim of none. */
	searchable?: string[] | null
	selectable?: string[]
	operators?: FilterOp[]
	operatorsByType?: Partial<Record<FieldType, FilterOp[]>>
	aliases?: Partial<Record<FilterOp, FilterOp>>
	identityFilter?: string
	emptyIn?: "reject" | "match-none"
	maxInValues?: number
	maxFilterConditions?: number
	searchModes?: SearchMode[]
	searchEmpty?: "ignore" | "match-all" | "reject"
	searchCase?: "sensitive" | "insensitive"
	sort?: {
		defaultOrder?: string
		stableTiebreak?: string
		nulls?: Nulls[]
		maxKeys?: number
	}
	select?: {
		nested?: boolean
		unknown?: "reject" | "ignore"
		relations?: SelectRelation[]
	}
	filterableFrom?: FilterableFrom
	sortableFrom?: FilterableFrom
	searchableFrom?: FilterableFrom
	selectableFrom?: FilterableFrom
}

export interface EffectiveFilterField {
	field: string
	type?: FieldType
	ops?: FilterOp[]
}

export interface EffectiveSortableField {
	field: string
	type?: FieldType
	nulls?: Nulls[]
}

export interface EffectiveQueryCapabilities {
	filterable: EffectiveFilterField[]
	sortable: EffectiveSortableField[]
	searchable: string[]
	selectable: string[]
	operators?: FilterOp[]
	operatorsByType?: Partial<Record<FieldType, FilterOp[]>>
	aliases: Partial<Record<FilterOp, FilterOp>>
	identityFilter?: string
	emptyIn?: "reject" | "match-none"
	maxInValues?: number
	maxFilterConditions?: number
	searchModes?: SearchMode[]
	searchEmpty?: "ignore" | "match-all" | "reject"
	searchCase?: "sensitive" | "insensitive"
	sort?: QueryCapabilities["sort"]
	select?: QueryCapabilities["select"]
	filterableFrom?: FilterableFrom
	sortableFrom?: FilterableFrom
	searchableFrom?: FilterableFrom
	selectableFrom?: FilterableFrom
	source: "tag" | "config" | "heuristic" | "mixed"
	hook: boolean
}

export interface MergeTag {
	filterable: string[]
	sortable: string[]
	searchable: string[]
	selectable: string[]
	source: "tag" | "heuristic"
	filterableDeclared?: boolean
	sortableDeclared?: boolean
	searchableDeclared?: boolean
	selectableDeclared?: boolean
	filterFields?: FilterableField[]
	sortableFields?: SortableField[]
	catalog?: QueryCapabilities
	defaultOrder?: string
	stableTiebreak?: string
}

export function isFilterOp(value: string): value is FilterOp {
	return (FILTER_OPS as readonly string[]).includes(value)
}

export function isFieldType(value: string): value is FieldType {
	return (FIELD_TYPES as readonly string[]).includes(value)
}

export function isNulls(value: string): value is Nulls {
	return value === "first" || value === "last"
}

export function emptyCapabilities(): EffectiveQueryCapabilities {
	return {
		aliases: {},
		filterable: [],
		hook: false,
		searchable: [],
		selectable: [],
		sortable: [],
		source: "heuristic",
	}
}

export function parseFilterable(value: unknown): { declared: boolean; fields: FilterableField[] } {
	if (value === undefined) return { declared: false, fields: [] }
	if (!Array.isArray(value)) return { declared: true, fields: [] }
	const fields: FilterableField[] = []
	for (const item of value) {
		if (typeof item === "string" && item !== "") {
			fields.push({ field: item })
			continue
		}
		if (item === null || typeof item !== "object") continue
		const rec = item as Record<string, unknown>
		if (typeof rec.field !== "string" || rec.field === "") continue
		const field: FilterableField = { field: rec.field }
		if (typeof rec.type === "string" && isFieldType(rec.type)) field.type = rec.type
		if (Array.isArray(rec.ops)) {
			const ops = rec.ops.filter((op): op is FilterOp => typeof op === "string" && isFilterOp(op))
			if (ops.length > 0) field.ops = ops
		}
		fields.push(field)
	}
	return { declared: true, fields }
}

export function parseSortable(value: unknown): { declared: boolean; fields: SortableField[] } {
	if (value === undefined) return { declared: false, fields: [] }
	if (!Array.isArray(value)) return { declared: true, fields: [] }
	const fields: SortableField[] = []
	for (const item of value) {
		if (typeof item === "string" && item !== "") {
			fields.push({ field: item })
			continue
		}
		if (item === null || typeof item !== "object") continue
		const rec = item as Record<string, unknown>
		if (typeof rec.field !== "string" || rec.field === "") continue
		const field: SortableField = { field: rec.field }
		if (typeof rec.type === "string" && isFieldType(rec.type)) field.type = rec.type
		if (Array.isArray(rec.nulls)) {
			const nulls = rec.nulls.filter((item): item is Nulls => typeof item === "string" && isNulls(item))
			if (nulls.length > 0) field.nulls = nulls
		}
		fields.push(field)
	}
	return { declared: true, fields }
}

export function parseQueryCatalog(tag: Record<string, unknown>): QueryCapabilities {
	const catalog: QueryCapabilities = {}
	const filterable = parseFilterable(tag.filterable)
	if (filterable.declared) catalog.filterable = filterable.fields
	const sortable = parseSortable(tag.sortable)
	if (sortable.declared) catalog.sortable = sortable.fields
	if (tag.searchable === null) catalog.searchable = null
	else if (Array.isArray(tag.searchable)) {
		catalog.searchable = tag.searchable.filter((v): v is string => typeof v === "string")
	}
	if (Array.isArray(tag.selectable)) {
		catalog.selectable = tag.selectable.filter((v): v is string => typeof v === "string")
	}
	if (Array.isArray(tag.operators)) {
		catalog.operators = tag.operators.filter((op): op is FilterOp => typeof op === "string" && isFilterOp(op))
	}
	if (tag.operatorsByType !== null && typeof tag.operatorsByType === "object" && !Array.isArray(tag.operatorsByType)) {
		const byType: Partial<Record<FieldType, FilterOp[]>> = {}
		for (const [key, raw] of Object.entries(tag.operatorsByType as Record<string, unknown>)) {
			if (!isFieldType(key) || !Array.isArray(raw)) continue
			byType[key] = raw.filter((op): op is FilterOp => typeof op === "string" && isFilterOp(op))
		}
		catalog.operatorsByType = byType
	}
	if (tag.aliases !== null && typeof tag.aliases === "object" && !Array.isArray(tag.aliases)) {
		const aliases: Partial<Record<FilterOp, FilterOp>> = {}
		for (const [key, raw] of Object.entries(tag.aliases as Record<string, unknown>)) {
			if (isFilterOp(key) && typeof raw === "string" && isFilterOp(raw)) aliases[key] = raw
		}
		catalog.aliases = aliases
	}
	if (typeof tag.identityFilter === "string" && tag.identityFilter !== "") catalog.identityFilter = tag.identityFilter
	if (tag.emptyIn === "reject" || tag.emptyIn === "match-none") catalog.emptyIn = tag.emptyIn
	if (typeof tag.maxInValues === "number" && Number.isFinite(tag.maxInValues) && tag.maxInValues > 0) {
		catalog.maxInValues = Math.floor(tag.maxInValues)
	}
	if (
		typeof tag.maxFilterConditions === "number" &&
		Number.isFinite(tag.maxFilterConditions) &&
		tag.maxFilterConditions > 0
	) {
		catalog.maxFilterConditions = Math.floor(tag.maxFilterConditions)
	}
	if (Array.isArray(tag.searchModes)) {
		catalog.searchModes = tag.searchModes.filter((v): v is string => typeof v === "string" && v !== "")
	}
	if (tag.searchEmpty === "ignore" || tag.searchEmpty === "match-all" || tag.searchEmpty === "reject") {
		catalog.searchEmpty = tag.searchEmpty
	}
	if (tag.searchCase === "sensitive" || tag.searchCase === "insensitive") catalog.searchCase = tag.searchCase

	const sort = parseSortBlock(tag)
	if (sort !== undefined) catalog.sort = sort
	const select = parseSelectBlock(tag)
	if (select !== undefined) catalog.select = select

	const filterableFrom = parseFilterableFrom(tag.filterableFrom)
	if (filterableFrom !== undefined) catalog.filterableFrom = filterableFrom
	const sortableFrom = parseFilterableFrom(tag.sortableFrom)
	if (sortableFrom !== undefined) catalog.sortableFrom = sortableFrom
	const searchableFrom = parseFilterableFrom(tag.searchableFrom)
	if (searchableFrom !== undefined) catalog.searchableFrom = searchableFrom
	const selectableFrom = parseFilterableFrom(tag.selectableFrom)
	if (selectableFrom !== undefined) catalog.selectableFrom = selectableFrom
	return catalog
}

function parseSortBlock(tag: Record<string, unknown>): QueryCapabilities["sort"] | undefined {
	const fromObject =
		tag.sort !== null && typeof tag.sort === "object" && !Array.isArray(tag.sort) ? tag.sort : undefined
	const rec = (fromObject ?? {}) as Record<string, unknown>
	const sort: NonNullable<QueryCapabilities["sort"]> = {}
	const defaultOrder =
		typeof rec.defaultOrder === "string"
			? rec.defaultOrder
			: typeof tag.defaultOrder === "string"
				? tag.defaultOrder
				: undefined
	const stableTiebreak =
		typeof rec.stableTiebreak === "string"
			? rec.stableTiebreak
			: typeof tag.stableTiebreak === "string"
				? tag.stableTiebreak
				: undefined
	const nullsRaw = rec.nulls ?? tag.sortNulls
	const maxKeysRaw = rec.maxKeys ?? tag.maxSortKeys
	if (defaultOrder !== undefined && defaultOrder !== "") sort.defaultOrder = defaultOrder
	if (stableTiebreak !== undefined && stableTiebreak !== "") sort.stableTiebreak = stableTiebreak
	if (Array.isArray(nullsRaw)) {
		const nulls = nullsRaw.filter((item): item is Nulls => typeof item === "string" && isNulls(item))
		if (nulls.length > 0) sort.nulls = nulls
	}
	if (typeof maxKeysRaw === "number" && Number.isFinite(maxKeysRaw) && maxKeysRaw > 0) {
		sort.maxKeys = Math.floor(maxKeysRaw)
	}
	return Object.keys(sort).length > 0 ? sort : undefined
}

function parseSelectBlock(tag: Record<string, unknown>): QueryCapabilities["select"] | undefined {
	const fromObject =
		tag.select !== null && typeof tag.select === "object" && !Array.isArray(tag.select) ? tag.select : undefined
	const rec = (fromObject ?? {}) as Record<string, unknown>
	const select: NonNullable<QueryCapabilities["select"]> = {}
	const nested = rec.nested ?? tag.selectNested
	const unknown = rec.unknown ?? tag.selectUnknown
	if (nested === true || nested === false) select.nested = nested
	if (unknown === "reject" || unknown === "ignore") select.unknown = unknown
	if (Array.isArray(rec.relations)) {
		const relations: SelectRelation[] = []
		for (const item of rec.relations) {
			if (item === null || typeof item !== "object") continue
			const rel = item as Record<string, unknown>
			if (typeof rel.name !== "string" || !Array.isArray(rel.fields)) continue
			relations.push({
				fields: rel.fields.filter((v): v is string => typeof v === "string"),
				name: rel.name,
			})
		}
		if (relations.length > 0) select.relations = relations
	}
	return Object.keys(select).length > 0 ? select : undefined
}

function parseFilterableFrom(raw: unknown): FilterableFrom | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
	const rec = raw as Record<string, unknown>
	if (typeof rec.path !== "string" || rec.path === "") return undefined
	const from: FilterableFrom = { path: rec.path }
	if (typeof rec.operationId === "string" && rec.operationId !== "") {
		if (/^(GET|POST|PUT|PATCH|DELETE)\s+/i.test(rec.operationId) || rec.operationId.startsWith("/")) {
			from.route = rec.operationId
		} else {
			from.operationId = rec.operationId
		}
	}
	if (typeof rec.route === "string" && rec.route !== "") from.route = rec.route
	if (typeof rec.typePath === "string" && rec.typePath !== "") from.typePath = rec.typePath
	if (rec.typeMap !== null && typeof rec.typeMap === "object" && !Array.isArray(rec.typeMap)) {
		const typeMap: Record<string, FieldType> = {}
		for (const [key, value] of Object.entries(rec.typeMap as Record<string, unknown>)) {
			if (typeof value === "string" && isFieldType(value)) typeMap[key] = value
		}
		from.typeMap = typeMap
	}
	return from
}

export function inferFieldType(schema: Record<string, unknown> | undefined): FieldType | undefined {
	if (schema === undefined) return undefined
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum"
	const format = typeof schema.format === "string" ? schema.format : ""
	if (format === "date" || format === "date-time") return "date"
	const type = schema.type
	if (type === "array") return "array"
	if (type === "boolean") return "boolean"
	if (type === "number" || type === "integer") return "number"
	if (type === "string") return "string"
	if (Array.isArray(type)) {
		const nonNull = type.filter((item) => item !== "null")
		const only = nonNull[0]
		if (nonNull.length === 1 && typeof only === "string") return inferFieldType({ ...schema, type: only })
	}
	return undefined
}

export function inferTypesFromSchema(schema: Record<string, unknown> | null | undefined): Map<string, FieldType> {
	const out = new Map<string, FieldType>()
	const props = schema?.properties
	if (props === null || props === undefined || typeof props !== "object") return out
	for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
		if (raw === null || typeof raw !== "object") continue
		const type = inferFieldType(raw as Record<string, unknown>)
		if (type !== undefined) out.set(name, type)
	}
	return out
}

export interface MergeInput {
	tag: MergeTag | null
	global?: QueryCapabilities
	entity?: QueryCapabilities
	itemSchema?: Record<string, unknown> | null
}

export function mergeQueryCapabilities(input: MergeInput): EffectiveQueryCapabilities {
	const types = inferTypesFromSchema(input.itemSchema ?? null)
	const catalog = overlayCatalog(input.tag, input.global, input.entity)

	const filterable = resolveAxisFields({
		config: [...(input.global?.filterable ?? []), ...(input.entity?.filterable ?? [])],
		configDeclared: input.global?.filterable !== undefined || input.entity?.filterable !== undefined,
		heuristic: (input.tag?.filterable ?? []).map((field) => ({ field })),
		tagDeclared: input.tag?.source === "tag" && input.tag.filterableDeclared === true,
		tagFields: input.tag?.filterFields ?? (input.tag?.filterable ?? []).map((field) => ({ field })),
	}).map((field) => withInferredType(field, types))

	const sortable = resolveAxisFields({
		config: [...(input.global?.sortable ?? []), ...(input.entity?.sortable ?? [])],
		configDeclared: input.global?.sortable !== undefined || input.entity?.sortable !== undefined,
		heuristic: (input.tag?.sortable ?? []).map((field) => ({ field })),
		tagDeclared: input.tag?.source === "tag" && input.tag.sortableDeclared === true,
		tagFields: input.tag?.sortableFields ?? (input.tag?.sortable ?? []).map((field) => ({ field })),
	}).map((field) => withInferredSortType(field, types))

	const searchable = resolveStringAxis({
		config: coalesceSearchable(input.entity?.searchable, input.global?.searchable),
		configDeclared: input.global?.searchable !== undefined || input.entity?.searchable !== undefined,
		heuristic: input.tag?.searchable ?? [],
		tagDeclared: input.tag?.source === "tag" && input.tag.searchableDeclared === true,
		tagValues: input.tag?.searchable ?? [],
	})

	const selectable = resolveStringAxis({
		config:
			input.entity?.selectable !== undefined
				? unionStrings(input.global?.selectable ?? [], input.entity.selectable)
				: (input.global?.selectable ?? []),
		configDeclared: input.global?.selectable !== undefined || input.entity?.selectable !== undefined,
		heuristic: input.tag?.selectable ?? [],
		tagDeclared: input.tag?.source === "tag" && input.tag.selectableDeclared === true,
		tagValues: input.tag?.selectable ?? [],
	})

	const tagContributed = input.tag?.source === "tag"
	const configContributed = input.global !== undefined || input.entity !== undefined
	const source: EffectiveQueryCapabilities["source"] =
		tagContributed && configContributed ? "mixed" : tagContributed ? "tag" : configContributed ? "config" : "heuristic"

	const result: EffectiveQueryCapabilities = {
		aliases: catalog.aliases ?? {},
		filterable,
		hook: false,
		searchable,
		selectable,
		sortable,
		source,
	}
	assignOptional(result, catalog)
	return result
}

function coalesceSearchable(
	entity: string[] | null | undefined,
	global: string[] | null | undefined,
): string[] | null | undefined {
	if (entity !== undefined) {
		if (entity === null) return []
		if (global === null || global === undefined) return entity
		return unionStrings(global, entity)
	}
	if (global === null) return []
	return global
}

function resolveAxisFields<T extends { field: string }>(input: {
	tagDeclared: boolean
	tagFields: T[]
	configDeclared: boolean
	config: T[]
	heuristic: T[]
}): T[] {
	let fields: T[] = []
	if (input.tagDeclared) fields = input.tagFields
	if (input.configDeclared) fields = unionNamed(fields, input.config)
	if (!input.tagDeclared && !input.configDeclared) fields = input.heuristic
	return fields
}

function resolveStringAxis(input: {
	tagDeclared: boolean
	tagValues: string[]
	configDeclared: boolean
	config: string[] | null | undefined
	heuristic: string[]
}): string[] {
	let values: string[] = []
	if (input.tagDeclared) values = input.tagValues
	if (input.configDeclared) {
		const extra = input.config ?? []
		values = unionStrings(values, extra)
	}
	if (!input.tagDeclared && !input.configDeclared) values = input.heuristic
	return values
}

function withInferredType(field: FilterableField, types: Map<string, FieldType>): EffectiveFilterField {
	const effective: EffectiveFilterField = { field: field.field }
	const type = field.type ?? types.get(field.field)
	if (type !== undefined) effective.type = type
	if (field.ops !== undefined) effective.ops = field.ops
	return effective
}

function withInferredSortType(field: SortableField, types: Map<string, FieldType>): EffectiveSortableField {
	const effective: EffectiveSortableField = { field: field.field }
	const type = field.type ?? types.get(field.field)
	if (type !== undefined) effective.type = type
	if (field.nulls !== undefined) effective.nulls = field.nulls
	return effective
}

function overlayCatalog(
	tag: MergeTag | null,
	global: QueryCapabilities | undefined,
	entity: QueryCapabilities | undefined,
): QueryCapabilities {
	const fromTag = tag?.catalog ?? {}
	if (tag?.defaultOrder !== undefined || tag?.stableTiebreak !== undefined) {
		fromTag.sort = {
			...fromTag.sort,
			...(tag.defaultOrder === undefined ? {} : { defaultOrder: tag.defaultOrder }),
			...(tag.stableTiebreak === undefined ? {} : { stableTiebreak: tag.stableTiebreak }),
		}
	}
	const out: QueryCapabilities = {}
	for (const layer of [fromTag, global, entity]) {
		if (layer === undefined) continue
		if (layer.operators !== undefined) out.operators = layer.operators
		if (layer.operatorsByType !== undefined) out.operatorsByType = { ...out.operatorsByType, ...layer.operatorsByType }
		if (layer.aliases !== undefined) out.aliases = { ...out.aliases, ...layer.aliases }
		if (layer.identityFilter !== undefined) out.identityFilter = layer.identityFilter
		if (layer.emptyIn !== undefined) out.emptyIn = layer.emptyIn
		if (layer.maxInValues !== undefined) out.maxInValues = layer.maxInValues
		if (layer.maxFilterConditions !== undefined) out.maxFilterConditions = layer.maxFilterConditions
		if (layer.searchModes !== undefined) out.searchModes = layer.searchModes
		if (layer.searchEmpty !== undefined) out.searchEmpty = layer.searchEmpty
		if (layer.searchCase !== undefined) out.searchCase = layer.searchCase
		if (layer.sort !== undefined) out.sort = { ...out.sort, ...layer.sort }
		if (layer.select !== undefined) out.select = { ...out.select, ...layer.select }
		if (layer.filterableFrom !== undefined) out.filterableFrom = layer.filterableFrom
		if (layer.sortableFrom !== undefined) out.sortableFrom = layer.sortableFrom
		if (layer.searchableFrom !== undefined) out.searchableFrom = layer.searchableFrom
		if (layer.selectableFrom !== undefined) out.selectableFrom = layer.selectableFrom
	}
	return out
}

function assignOptional(target: EffectiveQueryCapabilities, catalog: QueryCapabilities): void {
	if (catalog.operators !== undefined) target.operators = catalog.operators
	if (catalog.operatorsByType !== undefined) target.operatorsByType = catalog.operatorsByType
	if (catalog.identityFilter !== undefined) target.identityFilter = catalog.identityFilter
	if (catalog.emptyIn !== undefined) target.emptyIn = catalog.emptyIn
	if (catalog.maxInValues !== undefined) target.maxInValues = catalog.maxInValues
	if (catalog.maxFilterConditions !== undefined) target.maxFilterConditions = catalog.maxFilterConditions
	if (catalog.searchModes !== undefined) target.searchModes = catalog.searchModes
	if (catalog.searchEmpty !== undefined) target.searchEmpty = catalog.searchEmpty
	if (catalog.searchCase !== undefined) target.searchCase = catalog.searchCase
	if (catalog.sort !== undefined) target.sort = catalog.sort
	if (catalog.select !== undefined) target.select = catalog.select
	if (catalog.filterableFrom !== undefined) target.filterableFrom = catalog.filterableFrom
	if (catalog.sortableFrom !== undefined) target.sortableFrom = catalog.sortableFrom
	if (catalog.searchableFrom !== undefined) target.searchableFrom = catalog.searchableFrom
	if (catalog.selectableFrom !== undefined) target.selectableFrom = catalog.selectableFrom
}

function unionNamed<T extends { field: string }>(base: T[], extra: T[]): T[] {
	const byName = new Map<string, T>()
	for (const field of base) byName.set(field.field, { ...field })
	for (const field of extra) {
		const existing = byName.get(field.field)
		if (existing === undefined) {
			byName.set(field.field, { ...field })
			continue
		}
		byName.set(field.field, { ...existing, ...field })
	}
	return [...byName.values()]
}

function unionStrings(base: string[], extra: string[]): string[] {
	const seen = new Set(base)
	const out = [...base]
	for (const item of extra) {
		if (seen.has(item)) continue
		seen.add(item)
		out.push(item)
	}
	return out
}

export function opsForField(field: EffectiveFilterField, caps: EffectiveQueryCapabilities): FilterOp[] {
	if (field.ops !== undefined) return field.ops
	if (field.type !== undefined) {
		const byType = caps.operatorsByType?.[field.type]
		if (byType !== undefined) return byType
	}
	if (caps.operators !== undefined) return caps.operators
	return [...IMPLICIT_OPS]
}

export function opsAreClosed(field: EffectiveFilterField, caps: EffectiveQueryCapabilities): boolean {
	return (
		field.ops !== undefined ||
		(field.type !== undefined && caps.operatorsByType?.[field.type] !== undefined) ||
		caps.operators !== undefined
	)
}

export function fieldAllows(field: EffectiveFilterField, op: FilterOp, caps: EffectiveQueryCapabilities): boolean {
	const ops = opsForField(field, caps)
	if (ops.includes(op)) return true
	for (const [alias, target] of Object.entries(caps.aliases)) {
		if (target === op && isFilterOp(alias) && ops.includes(alias)) return true
	}
	return false
}

export function anyFieldAllows(caps: EffectiveQueryCapabilities, op: FilterOp): EffectiveFilterField | undefined {
	return caps.filterable.find((field) => fieldAllows(field, op, caps))
}

export function fieldAllowsNulls(
	field: EffectiveSortableField,
	caps: EffectiveQueryCapabilities,
	token: Nulls,
): boolean {
	if (field.nulls?.includes(token) === true) return true
	return caps.sort?.nulls?.includes(token) === true
}

export function applyHarvest(
	caps: EffectiveQueryCapabilities,
	names: string[],
	types: Array<string | undefined> = [],
	axis: "filterable" | "sortable" | "searchable" | "selectable" = "filterable",
): EffectiveQueryCapabilities {
	const extraNames = names.filter((name) => name !== "")
	if (axis === "searchable") return { ...caps, searchable: unionStrings(caps.searchable, extraNames) }
	if (axis === "selectable") return { ...caps, selectable: unionStrings(caps.selectable, extraNames) }
	if (axis === "sortable") {
		const extra: SortableField[] = extraNames.map((field) => {
			const rawType = types[extraNames.indexOf(field)]
			const mapped = mapHarvestType(caps.sortableFrom, rawType)
			const row: SortableField = { field }
			if (mapped !== undefined) row.type = mapped
			return row
		})
		return {
			...caps,
			sortable: unionNamed(
				caps.sortable,
				extra.map((field) => {
					const row: EffectiveSortableField = { field: field.field }
					if (field.type !== undefined) row.type = field.type
					return row
				}),
			),
		}
	}
	const extra: FilterableField[] = extraNames.map((name, index) => {
		const mapped = mapHarvestType(caps.filterableFrom, types[index])
		const field: FilterableField = { field: name }
		if (mapped !== undefined) field.type = mapped
		return field
	})
	return {
		...caps,
		filterable: unionNamed(
			caps.filterable,
			extra.map((field) => {
				const row: EffectiveFilterField = { field: field.field }
				if (field.type !== undefined) row.type = field.type
				if (field.ops !== undefined) row.ops = field.ops
				return row
			}),
		),
	}
}

function mapHarvestType(from: FilterableFrom | undefined, rawType: string | undefined): FieldType | undefined {
	if (rawType === undefined) return undefined
	return from?.typeMap?.[rawType] ?? (isFieldType(rawType) ? rawType : undefined)
}

export function applyHook(
	caps: EffectiveQueryCapabilities,
	result: FilterableField[] | Partial<QueryCapabilities> | null,
): EffectiveQueryCapabilities {
	if (result === null) return { ...caps, hook: true }
	if (Array.isArray(result)) {
		return {
			...caps,
			filterable: result.map((field) => toEffectiveFilter(field)),
			hook: true,
		}
	}
	const next: EffectiveQueryCapabilities = { ...caps, hook: true }
	if (result.filterable !== undefined) next.filterable = result.filterable.map((field) => toEffectiveFilter(field))
	if (result.sortable !== undefined) next.sortable = result.sortable.map((field) => toEffectiveSort(field))
	if (result.searchable !== undefined) next.searchable = result.searchable === null ? [] : [...result.searchable]
	if (result.selectable !== undefined) next.selectable = [...result.selectable]
	assignOptional(next, result)
	if (result.aliases !== undefined) next.aliases = { ...caps.aliases, ...result.aliases }
	if (caps.source === "heuristic") next.source = "config"
	return next
}

function toEffectiveFilter(field: FilterableField): EffectiveFilterField {
	const row: EffectiveFilterField = { field: field.field }
	if (field.type !== undefined) row.type = field.type
	if (field.ops !== undefined) row.ops = field.ops
	return row
}

function toEffectiveSort(field: SortableField): EffectiveSortableField {
	const row: EffectiveSortableField = { field: field.field }
	if (field.type !== undefined) row.type = field.type
	if (field.nulls !== undefined) row.nulls = field.nulls
	return row
}

/**
 * `$`, dots, `[n]`, `[*]`, and `[?(@.key==value)]`.
 * Used by `*From` harvest. Not a full JSONPath implementation.
 */
export function readJsonPathList(body: unknown, path: string): unknown[] {
	const trimmed = path.replace(/^\$\.?/, "")
	if (trimmed === "") return body === undefined ? [] : [body]
	let nodes: unknown[] = [body]
	for (const token of tokenizeJsonPath(trimmed)) {
		const next: unknown[] = []
		for (const node of nodes) {
			if (token === "*") {
				if (Array.isArray(node)) next.push(...node)
				continue
			}
			const filtered = applyJsonPathFilter(node, token)
			if (filtered !== undefined) {
				next.push(...filtered)
				continue
			}
			if (node === null || typeof node !== "object") continue
			if (Array.isArray(node) && /^\d+$/.test(token)) {
				next.push(node[Number(token)])
				continue
			}
			if (!Array.isArray(node)) next.push((node as Record<string, unknown>)[token])
		}
		nodes = next.filter((value) => value !== undefined)
	}
	return nodes
}

function applyJsonPathFilter(node: unknown, token: string): unknown[] | undefined {
	const match = /^\?\(@\.([A-Za-z_][\w]*)==(true|false|null|"[^"]*"|'[^']*'|[^\s)]+)\)$/.exec(token)
	if (match === null || !Array.isArray(node)) return undefined
	const key = match[1]
	const expected = parseJsonPathLiteral(match[2] ?? "")
	if (key === undefined) return undefined
	return node.filter((item) => {
		if (item === null || typeof item !== "object") return false
		return (item as Record<string, unknown>)[key] === expected
	})
}

function parseJsonPathLiteral(raw: string): unknown {
	if (raw === "true") return true
	if (raw === "false") return false
	if (raw === "null") return null
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1)
	}
	if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw)
	return raw
}

function tokenizeJsonPath(path: string): string[] {
	const out: string[] = []
	for (const part of path.split(".")) {
		const match = /^([^[]*)(?:\[(\*|\d+|\?\([^)]+\))\])?$/.exec(part)
		if (match === null) {
			out.push(part)
			continue
		}
		if (match[1] !== undefined && match[1] !== "") out.push(match[1])
		if (match[2] !== undefined) out.push(match[2])
	}
	return out
}
