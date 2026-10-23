/**
 * The `filterable` and `sortable` lists of an `x-query` tag: a name per field, or a row that adds
 * the field's type and its operators or nulls placements. Junk entries are dropped.
 */

import type { FilterableField, FilterOp, Nulls, SortableField } from "../../config/types/query.ts"
import type { RawOf } from "../../config/types/raw.ts"
import { isFieldType, isFilterOp, isNulls } from "./ops.ts"

export interface ParsedFields<T> {
	declared: boolean
	fields: T[]
}

/** A row as written: the keys of a filterable or sortable row, each unread. */
type Row = RawOf<FilterableField & SortableField>

/** One row of a field list: a non-empty name, or an object whose `field` is one. */
function readRow<T extends { field: string }>(item: unknown, extra: (field: T, rec: Row) => void): T | null {
	if (typeof item === "string" && item !== "") return { field: item } as T
	if (item === null || typeof item !== "object") return null
	const rec: Row = item
	if (typeof rec.field !== "string" || rec.field === "") return null
	const field = { field: rec.field } as T & { type?: unknown }
	if (typeof rec.type === "string" && isFieldType(rec.type)) field.type = rec.type
	extra(field, rec)
	return field
}

function readList<T extends { field: string }>(value: unknown, extra: (field: T, rec: Row) => void): ParsedFields<T> {
	if (value === undefined) return { declared: false, fields: [] }
	if (!Array.isArray(value)) return { declared: true, fields: [] }
	const fields: T[] = []
	for (const item of value) {
		const field = readRow(item, extra)
		if (field !== null) fields.push(field)
	}
	return { declared: true, fields }
}

function readOps(field: FilterableField, rec: Row): void {
	if (!Array.isArray(rec.ops)) return
	const ops = rec.ops.filter((op): op is FilterOp => typeof op === "string" && isFilterOp(op))
	if (ops.length > 0) field.ops = ops
}

function readNulls(field: SortableField, rec: Row): void {
	if (!Array.isArray(rec.nulls)) return
	const nulls = rec.nulls.filter((entry): entry is Nulls => typeof entry === "string" && isNulls(entry))
	if (nulls.length > 0) field.nulls = nulls
}

export function parseFilterable(value: unknown): ParsedFields<FilterableField> {
	return readList(value, readOps)
}

export function parseSortable(value: unknown): ParsedFields<SortableField> {
	return readList(value, readNulls)
}
