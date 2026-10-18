/** Where the probe field sits in a read of the caller, and whether an update to it stuck. */

export interface LocatedProbe {
	current: unknown
	values: unknown[]
	where: "missing" | "nested" | "top"
}

/** Top-level field, or the same field on each nested object when the read is a map of records. */
export function locateProbe(body: unknown, field: string): LocatedProbe {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { current: undefined, values: [], where: "missing" }
	}
	const record = body as Record<string, unknown>
	if (Object.prototype.hasOwnProperty.call(record, field)) {
		return { current: record[field], values: [record[field]], where: "top" }
	}
	const values: unknown[] = []
	for (const value of Object.values(record)) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) continue
		const child = value as Record<string, unknown>
		if (Object.prototype.hasOwnProperty.call(child, field)) values.push(child[field])
	}
	if (values.length === 0) return { current: undefined, values: [], where: "missing" }
	return { current: values[0], values, where: "nested" }
}

export function probeStuck(before: LocatedProbe, after: LocatedProbe, value: unknown): boolean {
	if (before.where === "nested") {
		return (
			after.where === "nested" &&
			after.values.includes(value) &&
			JSON.stringify(after.values) !== JSON.stringify(before.values)
		)
	}
	return after.current === value
}
