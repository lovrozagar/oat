/*
 * The one invalid body request.invalid-body-refused sends an operation, read from its request schema
 * alone, so every run sends the same one: a body missing its first required property (never for a
 * PATCH), else one whose first typed property, in document order, carries a value of another type.
 * A property the path already names is never the one broken. Only what a writer may
 * send is considered: readOnly properties, and optional x-privileged ones, are no part of the choice.
 */

import { ordinaryRequestSchema } from "../../../fixture.ts"
import type { SchemaObject as Schema } from "../../../../spec/types.ts"

/** How the body is made invalid: a required property left out, or a property sent the wrong type. */
export type InvalidChoice = { kind: "missing"; field: string } | { kind: "wrong-type"; field: string; value: unknown }

/* A value of each JSON type, in the order one is tried: the first no declared type admits is sent. */
const SPECIMENS: ReadonlyArray<[types: readonly string[], value: unknown]> = [
	[["integer", "number"], 7],
	[["string"], "oat-invalid"],
	[["boolean"], true],
	[["array"], []],
	[["object"], {}],
]

/** What a write's own request already settles: whether it merges, and the properties its path names. */
export interface ChoiceOptions {
	/** A PATCH keeps what its body leaves out, so a required property it omits is no error. */
	merge?: boolean
	/** The record's identity and the path's parameters: the server takes them from the path. */
	kept?: ReadonlySet<string>
}

/**
 * The invalid body's recipe for `schema`, or null when it names no property to break. Neither choice
 * touches a property the path already names (`kept`), nor a readOnly one, which no writer sends: a
 * server may rightly take the one from the path and ignore the other. A merge write is sent the wrong
 * type rather than missing a required property.
 */
export function invalidChoice(
	schema: Schema | boolean,
	{ merge = false, kept = new Set() }: ChoiceOptions = {},
): InvalidChoice | null {
	const ordinary = ordinaryRequestSchema(schema)
	if (typeof ordinary !== "object" || ordinary.properties === undefined) return null
	const properties = Object.entries(ordinary.properties as Record<string, Schema>).filter(([name]) => !kept.has(name))
	const breakable = new Set(properties.map(([name]) => name))
	const required = !merge && Array.isArray(ordinary.required) ? (ordinary.required as string[]) : []
	const missing = required.find((name) => breakable.has(name))
	if (missing !== undefined) return { field: missing, kind: "missing" }
	for (const [field, property] of properties) {
		const value = wrongTyped(property.type)
		if (value !== undefined) return { field, kind: "wrong-type", value }
	}
	return null
}

/** A value of a JSON type `type` does not admit; undefined when it admits them all or states none. */
export function wrongTyped(type: unknown): unknown {
	const admitted = typeof type === "string" ? [type] : Array.isArray(type) ? (type as unknown[]) : []
	if (admitted.length === 0) return undefined
	return SPECIMENS.find(([types]) => !types.some((name) => admitted.includes(name)))?.[1]
}

/** `base` made invalid by `choice`: a copy, the property removed or set to the wrong type. */
export function invalidated(base: Record<string, unknown>, choice: InvalidChoice): Record<string, unknown> {
	const { [choice.field]: _dropped, ...rest } = base
	return choice.kind === "missing" ? rest : { ...rest, [choice.field]: choice.value }
}
