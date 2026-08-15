/**
 * D1 drivers. Labs always persist on Cloudflare D1.
 *
 * - httpDriver: local Node process talking to the D1 HTTP API
 * - bindingDriver: a deployed Worker using env.DB
 */

export type SqlValue = string | number | null

export interface Driver {
	exec(sql: string): Promise<void>
	run(sql: string, args: SqlValue[]): Promise<void>
	all(sql: string, args: SqlValue[]): Promise<Record<string, unknown>[]>
}

interface D1HttpResponse {
	success: boolean
	errors?: Array<{ code: number; message: string }>
	result?: Array<{ results?: Record<string, unknown>[]; success?: boolean }>
}

export function httpDriver(config: { accountId: string; databaseId: string; apiToken: string }): Driver {
	const endpoint =
		`https://api.cloudflare.com/client/v4/accounts/${config.accountId}` + `/d1/database/${config.databaseId}/query`

	async function send(sql: string, params: SqlValue[]): Promise<Record<string, unknown>[]> {
		const response = await fetch(endpoint, {
			body: JSON.stringify({ params, sql }),
			headers: {
				authorization: `Bearer ${config.apiToken}`,
				"content-type": "application/json",
			},
			method: "POST",
		})
		const body = (await response.json()) as D1HttpResponse
		if (!response.ok || !body.success) {
			const detail =
				body.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") ?? `HTTP ${response.status}`
			throw new Error(`D1 query failed (${detail}) for: ${sql.slice(0, 160)}`)
		}
		return body.result?.[0]?.results ?? []
	}

	return {
		async all(sql, args) {
			return send(sql, args)
		},
		async exec(sql) {
			await send(sql, [])
		},
		async run(sql, args) {
			await send(sql, args)
		},
	}
}

/** Minimal D1 binding surface so the worker does not import workers-types. */
export interface D1Prepared {
	bind(...args: SqlValue[]): D1Prepared
	all(): Promise<{ results: Record<string, unknown>[] }>
	run(): Promise<unknown>
}

export interface D1Binding {
	prepare(sql: string): D1Prepared
	exec(sql: string): Promise<unknown>
}

export function bindingDriver(db: D1Binding): Driver {
	return {
		async all(sql, args) {
			const result = await db
				.prepare(sql)
				.bind(...args)
				.all()
			return result.results ?? []
		},
		async exec(sql) {
			await db.exec(sql)
		},
		async run(sql, args) {
			await db
				.prepare(sql)
				.bind(...args)
				.run()
		},
	}
}
