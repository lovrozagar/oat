/**
 * The cached-reads shape's read cache: each caller's item and list answers kept for a window and
 * served from there, as a CDN or a KV tier in front of a database would. A write does not touch it;
 * the window is the staleness the reads declare room for. The declared bypass asks the origin and
 * fills no copy, so oat's verification reads never leave one behind for another check, and
 * every answer says where it came from in `Cache-Status` (RFC 9211), a copy also its `Age`.
 */

import type { DefectSet } from "../defects/defect-set.ts"
import type { ReferenceShape } from "../shapes/types.ts"
import { CACHE_BYPASS } from "../spec/consistency.ts"
import type { ReferenceRequest, ReferenceResponse } from "./wire.ts"

/* The cached reads declare 1 s; the cache keeps a copy well inside it, or past it under STALE_PAST_BOUND. */
const WINDOW_MS = 400
const STALE_WINDOW_MS = 2500
const CACHE = "oat-reference"

interface Copy {
	response: ReferenceResponse
	storedAt: number
}

export interface CacheHolder {
	shape: Pick<ReferenceShape, "cachedReads">
	defects: DefectSet
	readCache: Map<string, Copy>
	clock: () => number
}

const withStatus = (response: ReferenceResponse, extra: Record<string, string>): ReferenceResponse => ({
	...response,
	headers: { ...response.headers, ...extra },
})

/** The read's answer: the caller's copy while it is in its window, else the origin's, kept when a 200. */
export async function cachedRead(
	state: CacheHolder,
	{ request, who }: { request: ReferenceRequest; who: string },
	origin: () => Promise<ReferenceResponse>,
): Promise<ReferenceResponse> {
	if (state.shape.cachedReads !== true) return origin()
	const asked = request.headers[CACHE_BYPASS.name] === CACHE_BYPASS.value
	if (asked && !state.defects.has("BYPASS_IGNORED"))
		return withStatus(await origin(), { "cache-status": `${CACHE}; fwd=bypass` })
	const key = `${who} ${request.url.pathname}${request.url.search}`
	const now = state.clock()
	const window = state.defects.has("STALE_PAST_BOUND") ? STALE_WINDOW_MS : WINDOW_MS
	const copy = state.readCache.get(key)
	if (copy !== undefined && now - copy.storedAt < window) {
		const age = String(Math.floor((now - copy.storedAt) / 1000))
		return withStatus(copy.response, { age, "cache-status": `${CACHE}; hit` })
	}
	const response = await origin()
	/* A read sent the bypass fills no copy, ignored or not: only a client's plain read does. */
	if (asked || response.status !== 200) return withStatus(response, { "cache-status": `${CACHE}; fwd=uri-miss` })
	state.readCache.set(key, { response, storedAt: now })
	return withStatus(response, { "cache-status": `${CACHE}; fwd=uri-miss; stored` })
}
