/** The field an update to the caller changes and reads back: a plain string, or else a boolean. */

const PREFERRED_FIELDS: readonly string[] = ["first_name", "display_name", "name", "nickname"]

export interface ProbeField {
	kind: "boolean" | "string"
	maxLength: number
	name: string
}

function asSchema(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

/** A nullable union is the non-null branch. `type: ["string", "null"]` is a string. */
function unwrap(schema: Record<string, unknown>): Record<string, unknown> {
	const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
	if (branches !== null) {
		const nonNull = branches
			.map(asSchema)
			.filter((branch): branch is Record<string, unknown> => branch !== null && branch.type !== "null")
		const only = nonNull.length === 1 ? nonNull[0] : undefined
		if (only !== undefined) return unwrap(only)
	}
	if (Array.isArray(schema.type)) {
		const types = schema.type.filter((type) => type !== "null")
		if (types.length === 1) return { ...schema, type: types[0] }
	}
	return schema
}

/** A string the probe can set and read back unchanged: free text, not an enum, a format or a pattern. */
function freeText(rec: Record<string, unknown>): boolean {
	if (Array.isArray(rec.enum)) return false
	if (rec.format === "email" || rec.format === "uri" || rec.format === "date-time") return false
	return typeof rec.pattern !== "string"
}

/** What one property offers the probe: a string, a boolean, or nothing. */
function fieldOf(name: string, value: unknown): ProbeField | null {
	const raw = asSchema(value)
	if (raw === null) return null
	const rec = unwrap(raw)
	if (rec.readOnly === true) return null
	if (rec.type === "boolean") return { kind: "boolean", maxLength: 0, name }
	if (rec.type !== "string" || !freeText(rec)) return null
	const maxLength = typeof rec.maxLength === "number" ? rec.maxLength : 64
	return maxLength < 4 ? null : { kind: "string", maxLength, name }
}

export function probeField(schema: unknown): ProbeField | null {
	const root = asSchema(schema)
	if (root === null) return null
	const properties = unwrap(root).properties
	if (properties === null || typeof properties !== "object") return null
	const record = properties as Record<string, unknown>
	const names = [
		...PREFERRED_FIELDS.filter((name) => record[name] !== undefined),
		...Object.keys(record).filter((name) => !PREFERRED_FIELDS.includes(name)),
	]
	let boolean: ProbeField | null = null
	for (const name of names) {
		const field = fieldOf(name, record[name])
		if (field?.kind === "string") return field
		if (field !== null) boolean ??= field
	}
	return boolean
}

export function nextValue(field: ProbeField, current: unknown): boolean | string {
	if (field.kind === "boolean") return current !== true
	const primary = "Oat".slice(0, field.maxLength)
	const alternate = "Xot".slice(0, field.maxLength)
	return current === primary ? alternate : primary
}
