/**
 * The cache bypass, as the bottom layer of a read's headers: the `x-consistency` bypass the read
 * declares, else `Cache-Control: no-cache` (RFC 9111). oat's reads verify writes, so they ask past
 * every cache unless a read asks to use it (`cache: "use"`, the staleness measurement) or the config
 * turns the bypass off. A header any other layer sends under that name wins, whatever its case.
 */

import type { CacheBypass } from "../spec/extensions/consistency.ts"
import type { RequestOptions, ResolvedOperation } from "./types.ts"

type Layer = Readonly<Record<string, string>>

const NO_CACHE: CacheBypass = { name: "cache-control", value: "no-cache" }

export interface BypassAsk {
	method: string
	resolved: ResolvedOperation | null
	cache?: RequestOptions["cache"]
	/** The config's `cache.bypass`: false sends none. */
	enabled: boolean
}

export function bypassLayer(ask: BypassAsk, layers: readonly Layer[]): Layer {
	if (!ask.enabled || ask.cache === "use" || ask.resolved === null || (ask.method !== "GET" && ask.method !== "HEAD"))
		return {}
	const bypass = ask.resolved.bypass ?? NO_CACHE
	const taken = layers.some((layer) => Object.keys(layer).some((name) => name.toLowerCase() === bypass.name))
	return taken ? {} : { [bypass.name]: bypass.value }
}
