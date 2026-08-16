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

export interface RequestContent {
	mediaType: string
	schema: SchemaObject
	encoding?: Record<string, { contentType?: string }>
}

/**
 * Prefers multipart, then urlencoded, then JSON, then the first listed type.
 * File ops often document both JSON and a form; the form is the real contract.
 */
export function requestContent(op: OperationObject): RequestContent | null {
	const content = op.requestBody?.content
	if (content === undefined) return null
	const keys = Object.keys(content)
	if (keys.length === 0) return null

	const mediaType = [...keys].sort((a, b) => mediaRank(a) - mediaRank(b) || keys.indexOf(a) - keys.indexOf(b))[0]
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

export function deriveCollectionShape(schema: SchemaObject | null): CollectionShape | null {
	if (schema === null) return null

	if (schema.type === "array") {
		return {
			envelopeKeys: [],
			itemSchema: asSchema(schema.items),
			key: null,
			pagination: {},
		}
	}

	const props = schema.properties
	if (props === null || typeof props !== "object") return null
	const entries = Object.entries(props as Record<string, SchemaObject>)

	const arrayProps = entries.filter(([, value]) => value?.type === "array")
	if (arrayProps.length === 0) return null

	/* With several array properties, the collection is the one whose items are objects and
	 * whose name is not an obvious sidecar (`errors`, `warnings`, `meta`). Ties break toward
	 * the property with the richest item schema — the real payload. */
	const candidates = arrayProps
		.filter(([name]) => !/^(errors?|warnings?|messages?|meta|links)$/i.test(name))
		.map(([name, value]) => ({ item: asSchema(value.items), name }))
		.filter((c) => c.item !== null)

	const chosen = candidates.find((c) => c.item?.type === "object" || c.item?.properties !== undefined) ?? candidates[0]
	if (chosen === undefined) return null

	const siblingNames = entries.map(([name]) => name).filter((name) => name !== chosen.name)
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
 * Finds the property that identifies an instance. Prefers a required identity-like property,
 * then any identity-like property, then the trailing path parameter's implied name.
 */
export function deriveIdentity(itemSchema: SchemaObject | null, pathParamHint?: string): string | null {
	if (itemSchema !== null) {
		const props = itemSchema.properties
		if (props !== null && typeof props === "object") {
			const names = Object.keys(props as Record<string, unknown>)
			const required = Array.isArray(itemSchema.required) ? (itemSchema.required as string[]) : []
			for (const candidate of IDENTITY_CANDIDATES) {
				if (required.includes(candidate)) return candidate
			}
			for (const candidate of IDENTITY_CANDIDATES) {
				if (names.includes(candidate)) return candidate
			}
		}
	}
	if (pathParamHint !== undefined) {
		/* `{table_id}` on `/tables/{table_id}` implies the item's own key is `id`. */
		const stripped = pathParamHint.replace(/^.*[_.]/, "")
		if (IDENTITY_CANDIDATES.includes(stripped)) return stripped
	}
	return null
}
