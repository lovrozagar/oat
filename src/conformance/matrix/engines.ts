export type Backend = "memory" | "sqlite" | "postgres" | "d1"

/** Whether this runtime can host the SQLite backend (`node:sqlite` needs a flag on Node 22). */
export async function sqliteAvailable(): Promise<boolean> {
	try {
		/* Constructing is the real test: on some builds the module resolves but the class is
		 * unusable, and a probe that only imports would report a false positive. */
		const { DatabaseSync } = await import("node:sqlite")
		new DatabaseSync(":memory:").close()
		return true
	} catch {
		return false
	}
}

/**
 * Whether D1 credentials are present. Deliberately not a live probe: a network call on every
 * `oat conformance` would tax the common path to answer a question about an opt-in backend.
 */
export function d1Available(): boolean {
	return (
		process.env.CLOUDFLARE_ACCOUNT_ID !== undefined &&
		process.env.CLOUDFLARE_D1_DATABASE_ID !== undefined &&
		process.env.CLOUDFLARE_API_TOKEN !== undefined
	)
}

/** Whether a Postgres server is reachable. Requires a running server, not just the driver. */
export async function postgresAvailable(): Promise<boolean> {
	try {
		const { default: postgres } = await import("postgres")
		const sql = postgres({ connect_timeout: 3, database: "postgres", max: 1, onnotice: () => {} })
		try {
			await sql`select 1`
			return true
		} finally {
			await sql.end({ timeout: 3 })
		}
	} catch {
		return false
	}
}
