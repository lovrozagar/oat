/**
 * `x-bind`: what an action's path, body and query take from the record it acts on, from the body
 * its prelude read, or as a literal.
 */

import { nestedParamId, scalarId } from "./ids.ts"
import { valueAt } from "./pointer.ts"

/** `x-bind` strings: a literal, `$.…` on the instance as it is now, or `before:$.…` on the prelude body. */
export interface ActionBind {
	path: Record<string, string>
	body: Record<string, string>
	query: Record<string, string>
}

export function readActionBind(value: unknown): ActionBind | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null
	const rec = value as Record<string, unknown>
	return { path: bindStrings(rec.path), body: bindStrings(rec.body), query: bindStrings(rec.query) }
}

export function readBefore(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined
}

function bindStrings(value: unknown): Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
	const out: Record<string, string> = {}
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && item !== "") out[key] = item
	}
	return out
}

function resolveBindExpr(expr: string, records: readonly Record<string, unknown>[], beforeBody: unknown): unknown {
	if (expr.startsWith("before:")) return valueAt(beforeBody, expr.slice("before:".length))
	if (!expr.startsWith("$")) return expr
	for (const record of records) {
		const value = valueAt(record, expr)
		if (value !== undefined) return value
	}
	return undefined
}

/** What an action's path is filled from: its params, the records it acts on, and what `x-bind` names. */
export interface ActionScopeInput {
	pathParams: readonly string[]
	records: readonly Record<string, unknown>[]
	scope: Record<string, string>
	bind: ActionBind | null
	beforeBody: unknown
}

/** Fill path params still missing after the instance id bind. Explicit `x-bind.path` wins over the stem walk. */
export function bindActionScope(input: ActionScopeInput): Record<string, string> {
	const { pathParams, records, scope, bind, beforeBody } = input
	const next = { ...scope }
	for (const param of pathParams) {
		const expr = bind?.path[param]
		if (expr !== undefined) {
			const value = resolveBindExpr(expr, records, beforeBody)
			const id = scalarId(value) ?? (Array.isArray(value) ? scalarId(value[0]) : undefined)
			if (id !== undefined) {
				next[param] = id
				continue
			}
		}
		if (next[param] !== undefined) continue
		for (const record of records) {
			const id = nestedParamId(record, param)
			if (id === undefined) continue
			next[param] = id
			break
		}
	}
	return next
}

/** Overlay `x-bind` body fields and query values. Literals pass through; pointers read the record or prelude. */
export function applyActionBind(
	bind: ActionBind | null,
	records: readonly Record<string, unknown>[],
	beforeBody: unknown,
	body: Record<string, unknown> | undefined,
): { body: Record<string, unknown> | undefined; query: Record<string, string> } {
	const query: Record<string, string> = {}
	if (bind === null) return { body, query }
	const next = body === undefined ? undefined : { ...body }
	for (const [field, expr] of Object.entries(bind.body)) {
		if (next === undefined) break
		const value = resolveBindExpr(expr, records, beforeBody)
		if (value === undefined) continue
		/* One id bound into a list field (`ids: $.id`) stays a list. */
		const current = next[field]
		next[field] = Array.isArray(current) && !Array.isArray(value) ? [value] : value
	}
	for (const [field, expr] of Object.entries(bind.query)) {
		const value = queryValue(resolveBindExpr(expr, records, beforeBody))
		if (value !== undefined) query[field] = value
	}
	return { body: next, query }
}

/** A bound value as query text: a string, a finite number, or a list's strings joined by commas. */
function queryValue(value: unknown): string | undefined {
	if (typeof value === "string" && value !== "") return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	if (!Array.isArray(value)) return undefined
	const joined = value.filter((item): item is string => typeof item === "string" && item !== "").join(",")
	return joined === "" ? undefined : joined
}
