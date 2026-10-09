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
