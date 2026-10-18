/**
 * The nested blocks of an `x-query` tag: `sort`, `select`, and a `*From` harvest source. Each
 * block may also be written as flat keys on the tag (`sortNulls`, `selectNested`); the block wins.
 */

import type { FieldType, FilterableFrom, Nulls, QueryCapabilities, SelectRelation } from "../../config/types/query.ts"
import { isFieldType, isNulls } from "./ops.ts"

type Rec = Record<string, unknown>
type SortBlock = NonNullable<QueryCapabilities["sort"]>
type SelectBlock = NonNullable<QueryCapabilities["select"]>

const isRecord = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value)

/** The tag's block under `key` when it is an object, else an empty one. */
const blockOf = (tag: Rec, key: string): Rec => {
	const value = tag[key]
	return isRecord(value) ? value : {}
}

const stringOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const positiveInt = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

const nonEmptyString = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined

function sortNulls(raw: unknown): Nulls[] | undefined {
	if (!Array.isArray(raw)) return undefined
	const nulls = raw.filter((item): item is Nulls => typeof item === "string" && isNulls(item))
	return nulls.length > 0 ? nulls : undefined
}

function sortCollation(raw: unknown): SortBlock["collation"] {
	return raw === "binary" || raw === "case-insensitive" || raw === "locale" ? raw : undefined
}

/** Keeps the defined entries of `pairs`, in order, or `undefined` when none is. */
function definedEntries<T extends object>(pairs: ReadonlyArray<readonly [keyof T, unknown]>): T | undefined {
	const out: Rec = {}
	for (const [key, value] of pairs) if (value !== undefined) out[key as string] = value
	return Object.keys(out).length > 0 ? (out as T) : undefined
}

export function parseSortBlock(tag: Rec): QueryCapabilities["sort"] | undefined {
	const rec = blockOf(tag, "sort")
	const defaultNulls = rec.defaultNulls ?? tag.sortDefaultNulls
	return definedEntries<SortBlock>([
		["collation", sortCollation(rec.collation ?? tag.sortCollation)],
		["defaultNulls", typeof defaultNulls === "string" && isNulls(defaultNulls) ? defaultNulls : undefined],
		["defaultOrder", nonEmptyString(stringOf(rec.defaultOrder) ?? stringOf(tag.defaultOrder))],
		["stableTiebreak", nonEmptyString(stringOf(rec.stableTiebreak) ?? stringOf(tag.stableTiebreak))],
		["nulls", sortNulls(rec.nulls ?? tag.sortNulls)],
		["maxKeys", positiveInt(rec.maxKeys ?? tag.maxSortKeys)],
	])
}

function selectRelations(raw: unknown): SelectRelation[] | undefined {
	if (!Array.isArray(raw)) return undefined
	const relations: SelectRelation[] = []
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue
		const rel = item as Rec
		if (typeof rel.name !== "string" || !Array.isArray(rel.fields)) continue
		relations.push({ fields: rel.fields.filter((v): v is string => typeof v === "string"), name: rel.name })
	}
	return relations.length > 0 ? relations : undefined
}

export function parseSelectBlock(tag: Rec): QueryCapabilities["select"] | undefined {
	const rec = blockOf(tag, "select")
	const nested = rec.nested ?? tag.selectNested
	const unknown = rec.unknown ?? tag.selectUnknown
	return definedEntries<SelectBlock>([
		["nested", nested === true || nested === false ? nested : undefined],
		["unknown", unknown === "reject" || unknown === "ignore" ? unknown : undefined],
		["relations", selectRelations(rec.relations)],
	])
}

/** An `operationId` that reads as a route (`GET /x`, `/x`) names the route instead. */
const ROUTE_LIKE = /^(GET|POST|PUT|PATCH|DELETE)\s+/i

function harvestTypeMap(raw: unknown): Record<string, FieldType> | undefined {
	if (!isRecord(raw)) return undefined
	const typeMap: Record<string, FieldType> = {}
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string" && isFieldType(value)) typeMap[key] = value
	}
	return typeMap
}

export function parseFilterableFrom(raw: unknown): FilterableFrom | undefined {
	if (!isRecord(raw)) return undefined
	const path = nonEmptyString(raw.path)
	if (path === undefined) return undefined
	const from: FilterableFrom = { path }
	const operationId = nonEmptyString(raw.operationId)
	if (operationId !== undefined) {
		if (ROUTE_LIKE.test(operationId) || operationId.startsWith("/")) from.route = operationId
		else from.operationId = operationId
	}
	const route = nonEmptyString(raw.route)
	if (route !== undefined) from.route = route
	const typePath = nonEmptyString(raw.typePath)
	if (typePath !== undefined) from.typePath = typePath
	const typeMap = harvestTypeMap(raw.typeMap)
	if (typeMap !== undefined) from.typeMap = typeMap
	return from
}
