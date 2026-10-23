/**
 * Lets a hook replace generated JSON fields (Stripe tokens, vendor ids) before the request
 * is encoded. `null` keeps the generator's value, same contract as `resolveUpload`.
 */

import type { Hooks, InputRequest } from "../config/types/hooks.ts"
import type { JsonSchema } from "../spec/types.ts"

/** The operation generated fields are sent to, and the schema they follow. */
export interface InputTarget {
	operationId: string
	schema: JsonSchema | undefined
}

export async function applyResolveInput(
	fields: Record<string, unknown>,
	hook: Hooks["resolveInput"],
	{ operationId, schema }: InputTarget,
): Promise<Record<string, unknown>> {
	if (hook === undefined) return fields
	return (await walk(fields, { pointer: "$", schema: schema ?? {} }, { hook, operationId })) as Record<string, unknown>
}

/** The hook, and the operation whose fields it is asked about. */
interface Resolver {
	operationId: string
	hook: NonNullable<Hooks["resolveInput"]>
}

/** Where the walk stands: the schema of the value and its JSON pointer. */
interface Place {
	schema: unknown
	pointer: string
}

async function walk(value: unknown, { schema, pointer }: Place, resolver: Resolver): Promise<unknown> {
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
			operationId: resolver.operationId,
			pointer: childPointer,
			schema: childSchema ?? {},
			value: Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined,
		}
		const resolved = await resolver.hook(request)
		if (resolved !== null && resolved !== undefined) {
			out[name] = resolved
			continue
		}
		const current = record[name]
		if (current !== undefined && childSchema !== undefined) {
			out[name] = await walk(current, { pointer: childPointer, schema: childSchema }, resolver)
		}
	}
	return out
}

function propertiesOf(schema: unknown): Record<string, unknown> {
	if (schema === null || typeof schema !== "object") return {}
	const properties = (schema as JsonSchema).properties
	if (properties === null || typeof properties !== "object") return {}
	return properties as Record<string, unknown>
}
