/** Unions that keep the first occurrence's place: named rows overlaid by name, and plain names. */

/** `extra` over `base` by `field`: a repeated name merges its row into the first one's place. */
export function unionNamed<T extends { field: string }>(base: T[], extra: T[]): T[] {
	const byName = new Map<string, T>()
	for (const field of base) byName.set(field.field, { ...field })
	for (const field of extra) byName.set(field.field, { ...byName.get(field.field), ...field })
	return [...byName.values()]
}

export function unionStrings(base: string[], extra: string[]): string[] {
	const seen = new Set(base)
	const out = [...base]
	for (const item of extra) {
		if (seen.has(item)) continue
		seen.add(item)
		out.push(item)
	}
	return out
}
