/**
 * What a run left behind, read from the backend itself rather than from oat's own bookkeeping.
 *
 * Counting `created − removed` trusts the ledger it is meant to audit: a record oat never ledgered
 * is neither created nor removed, and the count reads zero while tables sit in the backend. Every
 * live record present after the run and absent before it was left behind, whoever made it.
 */

export type StoreSnapshot = Record<string, Array<Record<string, unknown>>>

export function leftBehind(before: StoreSnapshot, after: StoreSnapshot): string[] {
	const out: string[] = []
	for (const [entity, rows] of Object.entries(after)) {
		const existed = new Set((before[entity] ?? []).map((row) => JSON.stringify(row.id)))
		for (const row of rows) {
			if (existed.has(JSON.stringify(row.id))) continue
			/* A tombstone is a removal: the API no longer serves it. */
			if (row.deleted_at !== null && row.deleted_at !== undefined) continue
			out.push(`${entity} ${String(row.id)}`)
		}
	}
	return out
}

/**
 * Records that existed before the run and are gone or different after it. oat may change only what
 * it created; on a correct backend, anything listed here is oat's doing.
 */
export function damagedBystanders(before: StoreSnapshot, after: StoreSnapshot): string[] {
	const out: string[] = []
	for (const [entity, rows] of Object.entries(before)) {
		const now = new Map((after[entity] ?? []).map((row) => [String(row.id), row]))
		for (const row of rows) {
			const later = now.get(String(row.id))
			if (later === undefined) {
				out.push(`${entity} ${String(row.id)} deleted`)
				continue
			}
			const changed = [...new Set([...Object.keys(row), ...Object.keys(later)])].filter(
				(key) => JSON.stringify(row[key]) !== JSON.stringify(later[key]),
			)
			if (changed.length > 0) out.push(`${entity} ${String(row.id)} changed ${changed.join(", ")}`)
		}
	}
	return out
}

/**
 * Ledgered ids the backend never created during the run. Teardown deletes what is ledgered, so an
 * id here is one oat would delete without having made it — an id it only sent, say.
 */
export function ledgeredNotCreated(
	records: ReadonlyArray<{ entity: string; id: string }>,
	created: Readonly<Record<string, readonly string[]>>,
): string[] {
	return records
		.filter((record) => !(created[record.entity] ?? []).includes(record.id))
		.map((record) => `${record.entity} ${record.id}`)
}
