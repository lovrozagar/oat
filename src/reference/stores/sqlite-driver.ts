/**
 * How the SQLite-dialect store reaches an engine.
 *
 * The store builds SQL; the driver runs it. Splitting them buys the thing an in-process database
 * cannot give: a *networked* SQLite, where every statement is a round trip, results arrive as
 * decoded JSON rather than native values, and the engine is a different build with different
 * compile-time flags. Cloudflare D1 leaves double-quoted-string fallback ON, which `node:sqlite`
 * compiles off — so a DDL/read naming mismatch is an error on one and silent wrong data on the
 * other. Only a real D1 can demonstrate which of those a given check survives.
 *
 * `node:sqlite` is imported dynamically and only by its own driver. Importing it at module scope
 * aborts any process started without `--experimental-sqlite`, which has taken down the CLI and
 * the Postgres path once each.
 */

export type SqlValue = string | number | null | Uint8Array

export type SqlRow = Record<string, unknown>

export interface SqliteDriver {
	/** Human-readable engine name, used in reports so a finding names where it was observed. */
	readonly engine: string
	/**
	 * Whether the engine resolves an unknown double-quoted identifier to a string literal
	 * instead of erroring — SQLite's double-quoted-string misfeature.
	 *
	 * `node:sqlite` compiles it off, D1 leaves it on. That difference decides whether a
	 * DDL/read naming mismatch is a loud error or silent wrong data, so the fixture has to know
	 * which it is: on a DQS engine it can express the bug in its natural form and let the engine
	 * produce the damage, and elsewhere it must emit the resulting literal directly.
	 */
	readonly dqs: boolean
	/** Statement with no bound parameters and no results — DDL. */
	exec(sql: string): Promise<void>
	/** Statement with no results. */
	run(sql: string, args: SqlValue[]): Promise<void>
	/** Statement returning rows. */
	all(sql: string, args: SqlValue[]): Promise<SqlRow[]>
	close(): Promise<void>
}

/** In-process SQLite via `node:sqlite`. Requires `--experimental-sqlite` on Node 22. */
export async function nodeSqliteDriver(): Promise<SqliteDriver> {
	const { DatabaseSync } = await import("node:sqlite")
	const db = new DatabaseSync(":memory:")
	db.exec("PRAGMA foreign_keys = OFF")

	return {
		async all(sql, args) {
			return db.prepare(sql).all(...(args as never[])) as SqlRow[]
		},
		async close() {
			db.close()
		},
		dqs: false,
		engine: "sqlite",
		async exec(sql) {
			db.exec(sql)
		},
		async run(sql, args) {
			db.prepare(sql).run(...(args as never[]))
		},
	}
}

export interface D1Config {
	accountId: string
	databaseId: string
	apiToken: string
}

interface D1Response {
	success: boolean
	errors?: Array<{ code: number; message: string }>
	result?: Array<{ results?: SqlRow[]; success?: boolean }>
}

/**
 * Cloudflare D1 over its HTTP query API.
 *
 * Every call is a network round trip to a shared, persistent database — which is the point. A
 * store that only ever ran against an in-process engine cannot show what happens when writes
 * take milliseconds to become visible, when the engine is someone else's build, or when two
 * runs share one database.
 */
export function d1Driver(config: D1Config): SqliteDriver {
	const endpoint =
		`https://api.cloudflare.com/client/v4/accounts/${config.accountId}` +
		`/d1/database/${config.databaseId}/query`

	async function send(sql: string, params: SqlValue[]): Promise<SqlRow[]> {
		const response = await fetch(endpoint, {
			body: JSON.stringify({ params: params.map(encode), sql }),
			headers: {
				authorization: `Bearer ${config.apiToken}`,
				"content-type": "application/json",
			},
			method: "POST",
		})

		const body = (await response.json()) as D1Response
		if (!response.ok || !body.success) {
			const detail =
				body.errors?.map((error) => `${error.code}: ${error.message}`).join("; ")
				?? `HTTP ${response.status}`
			/* Deliberately a plain Error, not SqlError: a transport or quota failure is not the
			 * backend rejecting the caller's input, and dressing it up as a 400 would let an
			 * outage read as a well-behaved validation response. */
			throw new Error(`D1 query failed (${detail}) for: ${sql.slice(0, 160)}`)
		}
		return body.result?.[0]?.results ?? []
	}

	return {
		async all(sql, args) {
			return send(sql, args)
		},
		async close() {
			/* Stateless HTTP — nothing to release. Table teardown is the store's job. */
		},
		/* Verified against a live D1, not assumed: `SELECT "no_such_col"` returns the string
		 * "no_such_col" for every row, where node:sqlite raises "no such column". */
		dqs: true,
		engine: "d1",
		async exec(sql) {
			await send(sql, [])
		},
		async run(sql, args) {
			await send(sql, args)
		},
	}
}

/**
 * D1 binds parameters as JSON, so a value's JSON type is its storage class. Booleans have no
 * SQLite representation and would arrive as `true`/`false` literals; the store already narrows
 * to 0/1 before binding, and this is the backstop for anything that slips past.
 */
function encode(value: SqlValue): string | number | null {
	if (value === null) return null
	if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
	return value
}
