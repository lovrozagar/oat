/**
 * What an answer says about the caches it came through: `Age` (RFC 9111), seconds since the origin
 * produced it, and `Cache-Status` (RFC 9211), one member per cache with whether it answered (`hit`)
 * or forwarded and why (`fwd`). A header that does not parse says nothing.
 */

import { headerValue } from "../runtime/headers.ts"

export interface CacheStatusEntry {
	cache: string
	hit: boolean
	fwd: string | null
}

export interface CacheSignals {
	ageS: number | null
	/** Nearest the origin first, as the header lists them. */
	status: readonly CacheStatusEntry[]
}

const DELTA_SECONDS = /^\d+$/

function member(text: string): CacheStatusEntry | null {
	const [name = "", ...params] = text.split(";").map((part) => part.trim())
	const cache = name.replace(/^"(.*)"$/s, "$1")
	if (cache === "") return null
	let hit = false
	let fwd: string | null = null
	for (const param of params) {
		const [key = "", value] = param.split("=").map((part) => part.trim())
		if (key === "hit") hit = value === undefined || value === "?1"
		if (key === "fwd" && value !== undefined) fwd = value.replace(/^"(.*)"$/s, "$1")
	}
	return { cache, fwd, hit }
}

/* Members split on commas outside quotes: a quoted cache name may hold one. */
function members(header: string): string[] {
	return header.match(/(?:[^,"]|"[^"]*")+/g) ?? []
}

export function readCacheSignals(headers: Readonly<Record<string, string>>): CacheSignals {
	const age = headerValue(headers, "age")?.trim() ?? ""
	const status = members(headerValue(headers, "cache-status") ?? "")
		.map(member)
		.filter((entry): entry is CacheStatusEntry => entry !== null)
	return { ageS: DELTA_SECONDS.test(age) ? Number(age) : null, status }
}
