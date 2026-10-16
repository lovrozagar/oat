/**
 * Derives collection shape from the response schema rather than guessing at wrapper key names.
 *
 * Hardcoding `["data","items","results","records"]` — as prior art does — returns null on any
 * API whose envelopes are named after the resource (`{ tables: [...] }`), which silently
 * disables every list-based assertion. The schema already states the answer; read it.
 */

import type { OperationObject, SchemaObject } from "./types.ts"

export interface CollectionShape {
	/** Property holding the array, or null when the response *is* the array. */
	key: string | null
	itemSchema: SchemaObject | null
	/** Sibling properties of the collection — `count`, `hasMore`, `nextCursor`, `page`. */
	envelopeKeys: string[]
	pagination: {
		countKey?: string
		hasMoreKey?: string
		cursorKey?: string
		pageKey?: string
		limitKey?: string
	}
}

const COUNT_KEYS = ["count", "total", "totalCount", "total_count", "totalItems"]
const HAS_MORE_KEYS = ["hasMore", "has_more", "hasNextPage", "more"]
const CURSOR_KEYS = ["nextCursor", "next_cursor", "cursor", "next", "endCursor"]
const PAGE_KEYS = ["page", "pageNumber", "page_number", "offset"]
const LIMIT_KEYS = ["limit", "perPage", "per_page", "pageSize", "page_size"]

export function successSchema(op: OperationObject): SchemaObject | null {
	const responses = op.responses ?? {}
	for (const code of ["200", "201", "202", "2XX", "default"]) {
		const content = responses[code]?.content
		if (content === undefined) continue
		for (const [mediaType, media] of Object.entries(content)) {
			if (!mediaType.includes("json")) continue
			if (media.schema !== undefined) return media.schema
		}
	}
	return null
}

/** True when a success response lists `text/event-stream`. That media type is the stream tag. */
export function documentsEventStream(op: OperationObject): boolean {
	const responses = op.responses ?? {}
	for (const [code, response] of Object.entries(responses)) {
		if (code !== "2XX" && code !== "default" && !/^2\d\d$/.test(code)) continue
		const content = response?.content
		if (content === undefined) continue
		for (const mediaType of Object.keys(content)) {
			if (mediaType.includes("text/event-stream")) return true
		}
	}
	return false
}

export interface RequestContent {
	mediaType: string
	schema: SchemaObject
	encoding?: Record<string, { contentType?: string }>
}

/**
 * Prefers multipart, then urlencoded, then JSON, then the first listed type.
 * File ops often document both JSON and a form; the form is the real contract.
 */
/** The request body oat sends: `preferred` when the operation documents it, else the best-ranked one. */
export function requestContent(op: OperationObject, preferred?: string): RequestContent | null {
	const content = op.requestBody?.content
	if (content === undefined) return null
	const keys = Object.keys(content)
	if (keys.length === 0) return null

	const mediaType =
		preferred !== undefined && keys.includes(preferred)
			? preferred
			: [...keys].sort((a, b) => mediaRank(a) - mediaRank(b) || keys.indexOf(a) - keys.indexOf(b))[0]
	if (mediaType === undefined) return null
	const media = content[mediaType]
	const picked: RequestContent = {
		mediaType,
		schema: media?.schema ?? {},
	}
	if (media?.encoding !== undefined) picked.encoding = media.encoding
	return picked
}

function mediaRank(mediaType: string): number {
	if (mediaType.startsWith("multipart/")) return 0
	if (mediaType.includes("x-www-form-urlencoded")) return 1
	if (mediaType.includes("json")) return 2
	return 3
}

export function hasRequestBody(op: OperationObject): boolean {
	const content = op.requestBody?.content
	return content !== undefined && Object.keys(content).length > 0
}

export function requestSchema(op: OperationObject): SchemaObject | null {
	const picked = requestContent(op)
	return picked === null ? null : picked.schema
}

/**
 * A schema as the instance sees it: `allOf` members merged into one object, and a nullable union
 * — `type: ["array", "null"]`, or `anyOf` / `oneOf` with a `null` branch — read as its one
 * non-null branch. A collection or an identity declared through either is still one.
 */
export function effective(schema: SchemaObject | null): SchemaObject | null {
	if (schema === null) return null
	const nonNull = (["anyOf", "oneOf"] as const)
		.map((key) => (Array.isArray(schema[key]) ? (schema[key] as SchemaObject[]) : null))
		.find((branches) => branches !== null)
		?.filter((branch) => branch?.type !== "null")
	if (nonNull !== undefined && nonNull.length === 1) return effective(nonNull[0] ?? null)
	const types = Array.isArray(schema.type) ? (schema.type as string[]).filter((type) => type !== "null") : null
	const typed = types !== null && types.length === 1 ? { ...schema, type: types[0] } : schema
	if (!Array.isArray(typed.allOf)) return typed
	const merged: SchemaObject = { ...typed, allOf: undefined }
	for (const part of typed.allOf as SchemaObject[]) {
		const member = effective(asSchema(part))
		if (member === null) continue
		merged.type ??= member.type
		merged.properties = {
			...(member.properties as Record<string, unknown> | undefined),
			...(merged.properties as Record<string, unknown> | undefined),
		}
		merged.required = [...new Set([...((merged.required as string[]) ?? []), ...((member.required as string[]) ?? [])])]
		if (merged.items === undefined && member.items !== undefined) merged.items = member.items
	}
	delete merged.allOf
	return merged
}

export function deriveCollectionShape(raw: SchemaObject | null, rowsKey?: string | null): CollectionShape | null {
	const schema = effective(raw)
	if (schema === null) return null

	if (schema.type === "array") {
		return {
			envelopeKeys: [],
			itemSchema: effective(asSchema(schema.items)),
			key: null,
			pagination: {},
		}
	}

	const props = schema.properties
	if (props === null || typeof props !== "object") return null
	const entries = Object.entries(props as Record<string, SchemaObject>).map(
		([name, value]) => [name, effective(value) ?? value] as [string, SchemaObject],
	)

	const arrayProps = entries.filter(([, value]) => value?.type === "array")
	if (arrayProps.length === 0) return null

	/* With several array properties, the collection is the one whose items are objects and
	 * whose name is not an obvious sidecar (`errors`, `warnings`, `meta`). Ties break toward
	 * the property with the richest item schema — the real payload. */
	const candidates = arrayProps
		.filter(([name]) => !/^(errors?|warnings?|messages?|meta|links)$/i.test(name))
		.map(([name, value]) => ({ item: effective(asSchema(value.items)), name }))
		.filter((c) => c.item !== null)

	/* Two arrays of objects (rows beside a `fields` sidecar) leave the rows unnamed: taking the
	 * first compares the wrong records. The list's `x-entity.recordPath` names them. */
	const objectRows = candidates.filter((c) => c.item?.type === "object" || c.item?.properties !== undefined)
	const chosen =
		rowsKey !== undefined && rowsKey !== null
			? candidates.find((c) => c.name === rowsKey)
			: objectRows.length > 1
				? undefined
				: (objectRows[0] ?? candidates[0])
	if (chosen === undefined) return null

	const siblingNames = entries.map(([name]) => name).filter((name) => name !== chosen.name)
	/* An envelope's other fields describe the page — counts, cursors, a meta or links sidecar.
	 * A body with its own nested objects beside the array (an OpenAPI document's `info` and
	 * `paths` beside `servers`) is a document that happens to hold a list, not a list. */
	const substantive = entries.filter(
		([name, value]) =>
			name !== chosen.name &&
			!/^(errors?|warnings?|messages?|meta|links|filters?|facets)$/i.test(name) &&
			(value?.type === "object" || value?.properties !== undefined || value?.additionalProperties !== undefined),
	)
	if (substantive.length > 0) return null
	const pagination: CollectionShape["pagination"] = {}
	const pick = (keys: string[]): string | undefined => siblingNames.find((n) => keys.includes(n))
	const countKey = pick(COUNT_KEYS)
	const hasMoreKey = pick(HAS_MORE_KEYS)
	const cursorKey = pick(CURSOR_KEYS)
	const pageKey = pick(PAGE_KEYS)
	const limitKey = pick(LIMIT_KEYS)
	if (countKey !== undefined) pagination.countKey = countKey
	if (hasMoreKey !== undefined) pagination.hasMoreKey = hasMoreKey
	if (cursorKey !== undefined) pagination.cursorKey = cursorKey
	if (pageKey !== undefined) pagination.pageKey = pageKey
	if (limitKey !== undefined) pagination.limitKey = limitKey

	return { envelopeKeys: siblingNames, itemSchema: chosen.item, key: chosen.name, pagination }
}

function asSchema(value: unknown): SchemaObject | null {
	return value !== null && typeof value === "object" ? (value as SchemaObject) : null
}

const IDENTITY_CANDIDATES = ["id", "uuid", "slug", "key", "name"]

/**
 * Finds the property that identifies an instance: the one the item route's own parameter names
 * when the schema has it (`{noteId}` → `id`), then a required identity-like property, then any
 * identity-like property, then the parameter's implied name. The route comes first because
 * teardown deletes through it: a `name` that is merely required would put a display value in the
 * delete path, whose 404 counts as removed while the real record stays behind.
 */
export function deriveIdentity(
	raw: SchemaObject | null,
	pathParamHint?: string,
	/** The route ends in that parameter, so it names this item rather than a parent. */
	itemRoute = true,
): string | null {
	/* `{table_id}` or `{tableId}` on `/tables/…` implies the item's own key is `id`. */
	const implied =
		pathParamHint === undefined
			? undefined
			: pathParamHint
					.replace(/^.*[_.-]/, "")
					.replace(/^[a-z0-9]+(?=[A-Z])/, "")
					.toLowerCase()
	const hinted = implied !== undefined && IDENTITY_CANDIDATES.includes(implied) ? implied : undefined
	const itemSchema = effective(raw)
	if (itemSchema !== null) {
		const props = itemSchema.properties
		if (props !== null && typeof props === "object") {
			const names = Object.keys(props as Record<string, unknown>)
			if (itemRoute && hinted !== undefined && names.includes(hinted)) return hinted
			const required = Array.isArray(itemSchema.required) ? (itemSchema.required as string[]) : []
			for (const candidate of IDENTITY_CANDIDATES) {
				if (required.includes(candidate)) return candidate
			}
			for (const candidate of IDENTITY_CANDIDATES) {
				if (names.includes(candidate)) return candidate
			}
		}
	}
	return hinted ?? null
}

/**
 * The arrays of objects a list response could hold its rows in, when there is more than one: a
 * document that leaves this open needs `x-entity.recordPath` on the list. Empty otherwise.
 */
export function ambiguousRows(raw: SchemaObject | null): string[] {
	const schema = effective(raw)
	if (schema === null || schema.type === "array") return []
	const props = schema.properties
	if (props === null || typeof props !== "object") return []
	const rows = Object.entries(props as Record<string, SchemaObject>)
		.filter(([name, value]) => {
			const resolved = effective(value) ?? value
			if (resolved?.type !== "array" || /^(errors?|warnings?|messages?|meta|links)$/i.test(name)) return false
			const item = effective(asSchema(resolved.items))
			return item?.type === "object" || item?.properties !== undefined
		})
		.map(([name]) => name)
	return rows.length > 1 ? rows : []
}

/** The top-level key a list's `recordPath` names (`$.data` or `$.data[*]`), or null. */
export function rowsKeyOf(recordPath: string | null): string | null {
	if (recordPath === null) return null
	const match = /^\$\.([A-Za-z0-9_-]+)(?:\[\*\])?$/.exec(recordPath)
	return match?.[1] ?? null
}
