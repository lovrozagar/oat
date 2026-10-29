/** `x-consistency`: how stale a read may be, and the request header that skips its cache. */

import type { OperationObject } from "../types.ts"
import { extObject } from "./tag.ts"

/** A request header that makes the read skip every cache: `x-fresh: 1`. Its name is lowercase. */
export interface CacheBypass {
	name: string
	value: string
}

export interface ConsistencySpec {
	/** How long after a write this read may still answer the old value; null when undeclared. */
	stalenessMs: number | null
	bypass: CacheBypass | null
}

/** The tag as written: `{ staleness: "30s", bypass: "x-fresh: 1" }`. */
interface ConsistencyTag {
	staleness: string
	bypass: string
}

const STALENESS = /^(\d+)s$/

/** `"<n>s"` in milliseconds; null for anything else. */
export function readStaleness(value: unknown): number | null {
	const match = typeof value === "string" ? STALENESS.exec(value) : null
	return match === null ? null : Number(match[1]) * 1000
}

/** `"<header>: <value>"`, split at the first colon; null without a name or a value. */
export function readBypass(value: unknown): CacheBypass | null {
	if (typeof value !== "string") return null
	const colon = value.indexOf(":")
	if (colon === -1) return null
	const name = value.slice(0, colon).trim().toLowerCase()
	const header = value.slice(colon + 1).trim()
	return name === "" || header === "" ? null : { name, value: header }
}

export function readConsistency(op: OperationObject): ConsistencySpec | null {
	const tag = extObject<ConsistencyTag>(op, "x-consistency")
	if (tag === undefined) return null
	const spec = { bypass: readBypass(tag.bypass), stalenessMs: readStaleness(tag.staleness) }
	return spec.bypass === null && spec.stalenessMs === null ? null : spec
}
