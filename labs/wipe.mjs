/**
 * Delete every row in a labs world's D1. Schema stays.
 *
 *   node --experimental-strip-types labs/wipe.mjs huge
 *   node --experimental-strip-types labs/wipe.mjs huge vast
 */
import { requireD1 } from "./kit/env.ts"
import { WORLDS } from "./worlds/catalog.ts"

const ids = process.argv.slice(2)
if (ids.length === 0) {
	console.error("wipe: pass world ids, e.g. node labs/wipe.mjs huge")
	process.exit(2)
}

for (const id of ids) {
	const world = WORLDS[id]
	if (world === undefined) {
		console.error(`wipe: unknown world ${id}`)
		process.exit(2)
	}
	const creds = requireD1(world.id)
	const endpoint =
		`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}` + `/d1/database/${creds.databaseId}/query`
	async function q(sql) {
		const response = await fetch(endpoint, {
			body: JSON.stringify({ params: [], sql }),
			headers: {
				authorization: `Bearer ${creds.apiToken}`,
				"content-type": "application/json",
			},
			method: "POST",
		})
		const body = await response.json()
		if (!response.ok || !body.success) {
			const detail = body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ?? `HTTP ${response.status}`
			throw new Error(`${detail} for ${sql.slice(0, 120)}`)
		}
		return body.result?.[0]?.results ?? []
	}

	const tables = ["idempotency", "invites", ...world.entities.map((e) => e.plural)]
	let rows = 0
	for (const table of tables) {
		const before = await q(`SELECT COUNT(*) AS n FROM "${table}"`)
		const n = Number(before[0]?.n ?? 0)
		if (n > 0) await q(`DELETE FROM "${table}"`)
		rows += n
	}
	console.log(`wiped ${id}  ${tables.length} tables  ${rows} rows`)
}
