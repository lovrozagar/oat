/** What the cached-reads shape's item and list reads declare about their cache. */

import type { Json, SpecContext } from "./types.ts"

/** The bypass the cached reads declare, and serve past the cache. */
export const CACHE_BYPASS = { name: "x-oat-fresh", value: "1" } as const

/** `x-consistency` for a read under the cached-reads shape; nothing otherwise. */
export function cacheDeclaration(ctx: SpecContext): Json {
	if (ctx.shape.cachedReads !== true) return {}
	return { "x-consistency": { bypass: `${CACHE_BYPASS.name}: ${CACHE_BYPASS.value}`, staleness: "1s" } }
}
