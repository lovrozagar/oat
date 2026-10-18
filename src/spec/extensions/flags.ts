/** Single-valued operation tags: soft delete, immutable and generated fields, cost, gates, flags, rate limits. */

import type { OperationObject } from "../types.ts"
import { ext, strArray } from "./tag.ts"

export function readSoftDelete(op: OperationObject): string | null {
	const value = ext<unknown>(op, "x-soft-delete")
	return typeof value === "string" ? value : null
}

export function readImmutable(op: OperationObject): string[] {
	return strArray(ext<unknown>(op, "x-immutable"))
}

export function readGenerated(op: OperationObject, bodySchema: unknown): string[] {
	const declared = strArray(ext<unknown>(op, "x-generated"))
	if (declared.length > 0) return declared
	/* `readOnly: true` carries the same meaning and is standard OpenAPI. */
	if (bodySchema === null || typeof bodySchema !== "object") return []
	const props = (bodySchema as Record<string, unknown>).properties
	if (props === null || typeof props !== "object") return []
	return Object.entries(props as Record<string, unknown>)
		.filter(([, v]) => v !== null && typeof v === "object" && (v as { readOnly?: unknown }).readOnly === true)
		.map(([k]) => k)
}

export function readCost(op: OperationObject): "low" | "medium" | "high" {
	const value = ext<unknown>(op, "x-cost")
	return value === "high" || value === "medium" ? value : "low"
}

/**
 * `x-feature-gate: <string>` — the plan key this operation is sold behind.
 *
 * A matching 403 is the document talking, not a fixture failure. Anything other than a string
 * (or a missing tag) is `null`, same defensive read as `readCost` / `readRateLimit`.
 */
export function readFeatureGate(op: OperationObject): string | null {
	const value = ext<unknown>(op, "x-feature-gate")
	return typeof value === "string" && value !== "" ? value : null
}

/**
 * A boolean tag. A malformed value is reported by `validateTags`; here it reads as `whenMalformed`
 * — `x-destructive` passes `true`, so a typo never makes a destructive operation look safe.
 */
export function readFlag(op: OperationObject, key: string, whenMalformed = false): boolean {
	const value = ext<unknown>(op, key)
	if (value === undefined || typeof value === "boolean") return value === true
	return whenMalformed
}

export interface RateLimitTag {
	category: string
	/** `null` when the tag names a category without a rate — still useful for grouping. */
	rps: number | null
}

/**
 * `x-rate-limit: { category: string, rps?: number }` — read defensively, like every other tag,
 * because the shape is the emitting app's policy to own, not oat's to assume. A category alone
 * (no `rps`) still groups operations sharing one budget; a config-level rate can complete it.
 */
export function readRateLimit(op: OperationObject): RateLimitTag | null {
	const value = ext<unknown>(op, "x-rate-limit")
	if (value === null || typeof value !== "object") return null
	const category = (value as Record<string, unknown>).category
	if (typeof category !== "string" || category === "") return null
	const rps = (value as Record<string, unknown>).rps
	return { category, rps: typeof rps === "number" && rps > 0 ? rps : null }
}
