/**
 * Values for a schema-built request: an operation's declared parameters, an example each schema
 * names, and a value an earlier success returned under the same name. A credential is never one:
 * a login's answer is a success too, and its tokens are not a record's values.
 */

import type { OperationObject } from "../../spec/types.ts"
import type { Redactor } from "../../security/redact.ts"
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

/** A value an earlier success already returned under exactly this name — the newest one that is no credential. */
export function seenValue(
	transcript: readonly Exchange[],
	name: string,
	redactor: Pick<Redactor, "holdsSecret">,
): string | undefined {
	return newestSeen(transcript, name, (value) => !redactor.holdsSecret(value))
}

/** The newest value an earlier success returned under exactly this name that `accept` takes. */
export function newestSeen(
	transcript: readonly Exchange[],
	name: string,
	accept: (value: string) => boolean,
): string | undefined {
	const want: Wanted = { accept, name }
	for (let index = transcript.length - 1; index >= 0; index--) {
		const exchange = transcript[index] as Exchange
		if (exchange.status < 200 || exchange.status >= 300) continue
		const hit = findNamed(exchange.responseBody, want, 0)
		if (hit !== undefined) return hit
	}
	return undefined
}

interface Wanted {
	name: string
	accept: (value: string) => boolean
}

/** The first acceptable non-empty string or number under `want.name`, at most five levels down. */
function findNamed(node: unknown, want: Wanted, depth: number): string | undefined {
	if (depth > 5 || node === null || typeof node !== "object") return undefined
	if (Array.isArray(node)) {
		for (const item of node) {
			const hit = findNamed(item, want, depth + 1)
			if (hit !== undefined) return hit
		}
		return undefined
	}
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		const hit = key === want.name ? candidate(value, want) : undefined
		if (hit !== undefined) return hit
		const deeper = findNamed(value, want, depth + 1)
		if (deeper !== undefined) return deeper
	}
	return undefined
}

/* A string or number, as text, when it is non-empty and acceptable. */
function candidate(value: unknown, want: Wanted): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined
	const text = String(value)
	return text !== "" && want.accept(text) ? text : undefined
}

export function snippet(body: unknown): string {
	const text = typeof body === "string" ? body : JSON.stringify(body)
	return text === undefined ? "" : text.slice(0, 160)
}
