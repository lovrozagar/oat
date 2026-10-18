/**
 * Values for a schema-built request: an operation's declared parameters, an example each schema
 * names, and a value an earlier success returned under the same name.
 */

import type { OperationObject } from "../../spec/types.ts"
import type { Exchange } from "../exchange.ts"

export interface Parameter {
	in?: string
	name?: string
	required?: boolean
	schema?: { enum?: unknown[]; default?: unknown; type?: string }
}

export function parametersOf(raw: OperationObject): Parameter[] {
	const params = (raw as { parameters?: unknown }).parameters
	return Array.isArray(params) ? (params as Parameter[]) : []
}

export function exampleOf(schema: Parameter["schema"]): string | undefined {
	if (schema?.enum !== undefined && schema.enum.length > 0) return String(schema.enum[0])
	if (schema?.default !== undefined) return String(schema.default)
	if (schema?.type === "integer" || schema?.type === "number") return "1"
	if (schema?.type === "boolean") return "true"
	if (schema?.type === "string") return "oat"
	return undefined
}

/** A value an earlier success already returned under exactly this name — the newest one. */
export function seenValue(transcript: readonly Exchange[], name: string): string | undefined {
	for (let index = transcript.length - 1; index >= 0; index--) {
		const exchange = transcript[index] as Exchange
		if (exchange.status < 200 || exchange.status >= 300) continue
		const hit = findNamed(exchange.responseBody, name, 0)
		if (hit !== undefined) return hit
	}
	return undefined
}

/** The first non-empty string or number under `name`, at most five levels down. */
function findNamed(node: unknown, name: string, depth: number): string | undefined {
	if (depth > 5 || node === null || typeof node !== "object") return undefined
	if (Array.isArray(node)) {
		for (const item of node) {
			const hit = findNamed(item, name, depth + 1)
			if (hit !== undefined) return hit
		}
		return undefined
	}
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (key === name && (typeof value === "string" || typeof value === "number") && String(value) !== "") {
			return String(value)
		}
		const hit = findNamed(value, name, depth + 1)
		if (hit !== undefined) return hit
	}
	return undefined
}

export function snippet(body: unknown): string {
	const text = typeof body === "string" ? body : JSON.stringify(body)
	return text === undefined ? "" : text.slice(0, 160)
}
