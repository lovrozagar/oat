/**
 * Lets a hook replace generated JSON fields (Stripe tokens, vendor ids) before the request
 * is encoded. `null` keeps the generator's value, same contract as `resolveUpload`.
 */

import type { Hooks, InputRequest } from "../config/define-config.ts"

export async function applyResolveInput(
	fields: Record<string, unknown>,
	operationId: string,
	schema: Record<string, unknown> | undefined,
	hook: Hooks["resolveInput"],
): Promise<Record<string, unknown>> {
	if (hook === undefined) return fields
	return (await walk(fields, operationId, schema ?? {}, "$", hook)) as Record<string, unknown>
}

async function walk(
	value: unknown,
	operationId: string,
	schema: unknown,
	pointer: string,
	hook: NonNullable<Hooks["resolveInput"]>,
): Promise<unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value
	const record = value as Record<string, unknown>
	const properties = propertiesOf(schema)
	const out: Record<string, unknown> = { ...record }
	const names = new Set([...Object.keys(record), ...Object.keys(properties)])
	for (const name of names) {
		const childPointer = pointer === "$" ? `$.${name}` : `${pointer}.${name}`
		const childSchema = properties[name]
		const request: InputRequest = {
			field: name,
			operationId,
			pointer: childPointer,
			schema: childSchema ?? {},
		}
		const resolved = await hook(request)
		if (resolved !== null && resolved !== undefined) {
			out[name] = resolved
			continue
		}
		const current = record[name]
		if (current !== undefined && childSchema !== undefined) {
			out[name] = await walk(current, operationId, childSchema, childPointer, hook)
		}
	}
	return out
}

function propertiesOf(schema: unknown): Record<string, unknown> {
	if (schema === null || typeof schema !== "object") return {}
	const properties = (schema as Record<string, unknown>).properties
	if (properties === null || typeof properties !== "object") return {}
	return properties as Record<string, unknown>
}
