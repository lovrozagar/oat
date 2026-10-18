import type postgres from "postgres"

export type Backend = "memory" | "sqlite" | "postgres" | "d1"

/** Loads `node:sqlite`; a test brings a runtime that cannot. */
type LoadSqlite = () => Promise<Pick<typeof import("node:sqlite"), "DatabaseSync">>

/** Whether this runtime can host the SQLite backend (`node:sqlite` needs a flag on Node 22). */
export async function sqliteAvailable(load: LoadSqlite = () => import("node:sqlite")): Promise<boolean> {
	try {
		/* Constructing is the real test: on some builds the module resolves but the class is
		 * unusable, and a probe that only imports would report a false positive. */
		const { DatabaseSync } = await load()
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

/** What the probe needs of a Postgres connection; postgres.js's client is one. */
export interface ProbeConnection {
	unsafe(query: string): PromiseLike<unknown>
	end(options: { timeout: number }): Promise<void>
}

/** The real driver against the server the environment names: one short-lived session, notices silenced. */
export async function connectProbe(): Promise<ReturnType<typeof postgres>> {
	const { default: connect } = await import("postgres")
	return connect({ connect_timeout: 3, database: "postgres", max: 1, onnotice: () => {} })
}

/** Whether a Postgres server is reachable. Requires a running server, not just the driver. */
export async function postgresAvailable(connect: () => Promise<ProbeConnection> = connectProbe): Promise<boolean> {
	try {
		const sql = await connect()
		try {
			await sql.unsafe("select 1")
			return true
		} finally {
			await sql.end({ timeout: 3 })
		}
	} catch {
		return false
	}
}
