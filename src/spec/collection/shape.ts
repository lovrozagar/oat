/**
 * Derives collection shape from the response schema rather than guessing at wrapper key names.
 *
 * Hardcoding `["data","items","results","records"]` — as prior art does — returns null on any
 * API whose envelopes are named after the resource (`{ tables: [...] }`), which silently
 * disables every list-based assertion. The schema already states the answer; read it.
 */

import type { JsonSchema } from "../types.ts"
import { asSchema, effective } from "./effective.ts"

export interface CollectionShape {
	/** Property holding the array, or null when the response *is* the array. */
	key: string | null
	itemSchema: JsonSchema | null
	/** Sibling properties of the collection — `count`, `hasMore`, `nextCursor`, `page`. */
	envelopeKeys: string[]
	/**
	 * Where each row keeps its record, one property name per step: `["document"]` for
	 * `$.hits[*].document`. Empty when the row is the record.
	 */
	within: string[]
	pagination: {
		countKey?: string
		hasMoreKey?: string
		cursorKey?: string
		pageKey?: string
		limitKey?: string
	}
}

type Pagination = CollectionShape["pagination"]

/** The sibling names each pagination key is read from, in the order the shape lists them. */
const PAGINATION_KEYS: ReadonlyArray<readonly [keyof Pagination, readonly string[]]> = [
	["countKey", ["count", "total", "totalCount", "total_count", "totalItems"]],
	["hasMoreKey", ["hasMore", "has_more", "hasNextPage", "more"]],
	["cursorKey", ["nextCursor", "next_cursor", "cursor", "next", "endCursor"]],
	["pageKey", ["page", "pageNumber", "page_number", "offset"]],
	["limitKey", ["limit", "perPage", "per_page", "pageSize", "page_size"]],
]

/** Array properties that are an obvious sidecar, never the rows. */
const SIDECAR = /^(errors?|warnings?|messages?|meta|links)$/i
/** Object properties an envelope may carry beside its rows. */
const PAGE_SIDECAR = /^(errors?|warnings?|messages?|meta|links|filters?|facets)$/i

type Entry = [string, JsonSchema | null]

interface Candidate {
	name: string
	item: JsonSchema
}

const holdsObjects = (item: JsonSchema | null): boolean => item?.type === "object" || item?.properties !== undefined

/** The schema's properties, each read as the instance sees it; `null` when it has none. */
function propertyEntries(schema: JsonSchema): Entry[] | null {
	const props = schema.properties
	if (props === null || typeof props !== "object") return null
	return Object.entries(props as Record<string, unknown>).map(([name, value]) => [name, effective(asSchema(value))])
}

/**
 * With several array properties, the collection is the one whose items are objects and whose
 * name is not an obvious sidecar (`errors`, `warnings`, `meta`). Two arrays of objects (rows
 * beside a `fields` sidecar) leave the rows unnamed: taking the first compares the wrong records,
 * so the list's `x-entity.recordPath` names them.
 */
function chooseRows(entries: Entry[], rowsKey: string | undefined): Candidate | undefined {
	const candidates = entries
		.filter(([name, value]) => value?.type === "array" && !SIDECAR.test(name))
		.map(([name, value]) => ({ item: effective(asSchema((value as JsonSchema).items)), name }))
		.filter((c): c is Candidate => c.item !== null)
	if (rowsKey !== undefined) return candidates.find((c) => c.name === rowsKey)
	const objectRows = candidates.filter((c) => holdsObjects(c.item))
	return objectRows.length > 1 ? undefined : (objectRows[0] ?? candidates[0])
}

function paginationOf(siblingNames: string[]): Pagination {
	const pagination: Pagination = {}
	for (const [key, names] of PAGINATION_KEYS) {
		const found = siblingNames.find((name) => names.includes(name))
		if (found !== undefined) pagination[key] = found
	}
	return pagination
}

/**
 * An envelope's other fields describe the page — counts, cursors, a meta or links sidecar. A body
 * with its own nested objects beside the array (an OpenAPI document's `info` and `paths` beside
 * `servers`) is a document that happens to hold a list, not a list.
 */
function hasSubstantiveSibling(entries: Entry[], chosen: string): boolean {
	return entries.some(
		([name, value]) =>
			name !== chosen && !PAGE_SIDECAR.test(name) && (holdsObjects(value) || value?.additionalProperties !== undefined),
	)
}

/* The schema `within` names inside a row's, or null where the row's schema does not say. */
function schemaWithin(row: JsonSchema, within: readonly string[]): JsonSchema | null {
	let schema: JsonSchema | null = row
	for (const name of within) schema = effective(asSchema(asSchema(schema?.properties)?.[name]))
	return schema
}

/**
 * The list a response holds, read from its schema. A declared `recordPath` names the rows and
 * where each keeps its record; without one the rows are inferred, and a body with substantive
 * siblings beside its array is read as a document that holds a list, not a list. A declaration
 * is the author saying otherwise: Typesense answers `request_params` beside its `hits`.
 */
export function deriveCollectionShape(
	raw: JsonSchema | null,
	recordPath: string | null = null,
): CollectionShape | null {
	const schema = effective(raw)
	if (schema === null) return null
	if (schema.type === "array") {
		return { envelopeKeys: [], itemSchema: effective(asSchema(schema.items)), key: null, pagination: {}, within: [] }
	}
	const entries = propertyEntries(schema)
	if (entries === null) return null
	const declared = rowsOf(recordPath)
	const chosen = chooseRows(entries, declared?.key)
	if (chosen === undefined || (declared === null && hasSubstantiveSibling(entries, chosen.name))) return null
	const siblingNames = entries.map(([name]) => name).filter((name) => name !== chosen.name)
	const within = declared?.within ?? []
	return {
		envelopeKeys: siblingNames,
		itemSchema: schemaWithin(chosen.item, within),
		key: chosen.name,
		pagination: paginationOf(siblingNames),
		within,
	}
}

/**
 * The arrays of objects a list response could hold its rows in, when there is more than one: a
 * document that leaves this open needs `x-entity.recordPath` on the list. Empty otherwise.
 */
export function ambiguousRows(raw: JsonSchema | null): string[] {
	const schema = effective(raw)
	if (schema === null || schema.type === "array") return []
	const entries = propertyEntries(schema) ?? []
	const rows = entries
		.filter(
			([name, value]) =>
				value?.type === "array" && !SIDECAR.test(name) && holdsObjects(effective(asSchema(value.items))),
		)
		.map(([name]) => name)
	return rows.length > 1 ? rows : []
}

/** Where a list's `recordPath` says its records are: the rows' top-level key, and each record within a row. */
export interface Rows {
	key: string
	within: string[]
}

/* `$.data`, `$.data[*]`, or `$.hits[*].document` and deeper: rows under one top-level key. A
 * name is anything but a separator, a bracket or a space. */
const ROWS_PATH = /^\$\.([^.[\]\s]+)(?:\[\*\]((?:\.[^.[\]\s]+)*))?$/

/** The rows a list's `recordPath` names (`$.data`, `$.data[*]`, `$.hits[*].document`), or null. */
export function rowsOf(recordPath: string | null): Rows | null {
	const match = recordPath === null ? null : ROWS_PATH.exec(recordPath)
	if (match === null) return null
	return { key: match[1] as string, within: (match[2] ?? "").split(".").filter(Boolean) }
}
