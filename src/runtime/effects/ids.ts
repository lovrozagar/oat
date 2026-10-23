/**
 * Ids in a write's response: a conventional id field a few levels down, or the first row of an
 * array named after a path parameter's stem.
 */

export function scalarId(value: unknown): string | undefined {
	if (typeof value === "string" && value !== "") return value
	if (typeof value === "number" && Number.isFinite(value)) return String(value)
	return undefined
}

/** Conventional `{entity}_id`, then the entity identity, then `id`. */
export function createdIdKeys(entity: string, identity: string | null): string[] {
	const keys = [`${entity}_id`]
	if (identity !== null && identity !== "" && !keys.includes(identity)) keys.push(identity)
	if (!keys.includes("id")) keys.push("id")
	return keys
}

/** Walks objects / arrays a few levels for a conventional id field. */
export function findCreatedId(body: unknown, keys: readonly string[], depth = 0): string | undefined {
	if (body === null || typeof body !== "object" || depth > 3) return undefined
	if (Array.isArray(body)) {
		for (const item of body) {
			const found = findCreatedId(item, keys, depth + 1)
			if (found !== undefined) return found
		}
		return undefined
	}
	const rec = body as Record<string, unknown>
	for (const key of keys) {
		const id = scalarId(rec[key])
		if (id !== undefined) return id
	}
	for (const value of Object.values(rec)) {
		const found = findCreatedId(value, keys, depth + 1)
		if (found !== undefined) return found
	}
	return undefined
}

/**
 * First id under a key that names this path param. `col_id` reads `columns_json[0].id`
 * when the record has no literal `col_id`.
 */
export function nestedParamId(record: Record<string, unknown>, param: string): string | undefined {
	const direct = findCreatedId(record, [param])
	if (direct !== undefined) return direct
	if (!param.endsWith("_id")) return undefined
	return stemArrayId(record, param.slice(0, -"_id".length), 0)
}

function stemArrayId(value: unknown, stem: string, depth: number): string | undefined {
	if (stem === "" || depth > 6 || value === null || typeof value !== "object") return undefined
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = stemArrayId(item, stem, depth + 1)
			if (found !== undefined) return found
		}
		return undefined
	}
	for (const [key, child] of Object.entries(value)) {
		const id = namesStem(key, stem) && Array.isArray(child) ? firstRowId(child) : undefined
		if (id !== undefined) return id
		const deeper = stemArrayId(child, stem, depth + 1)
		if (deeper !== undefined) return deeper
	}
	return undefined
}

/** `columns`, `columns_json` and `col_list` all name the stem `col`. */
function namesStem(key: string, stem: string): boolean {
	const bare = key.replace(/_json$/, "")
	return bare === stem || bare === `${stem}s` || bare.startsWith(stem)
}

/** The `id` of the first object row that has one. */
function firstRowId(rows: readonly unknown[]): string | undefined {
	for (const item of rows) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) continue
		const id = scalarId((item as Record<string, unknown>)["id"])
		if (id !== undefined) return id
	}
	return undefined
}
