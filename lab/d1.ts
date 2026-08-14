/**
 * D1 HTTP driver. Lives in the lab so the backend does not import oat's src/.
 */

export type SqlValue = string | number | null

export interface Driver {
	exec(sql: string): Promise<void>
	run(sql: string, args: SqlValue[]): Promise<void>
	all(sql: string, args: SqlValue[]): Promise<Record<string, unknown>[]>
}

interface D1Response {
	success: boolean
	errors?: Array<{ code: number; message: string }>
	result?: Array<{ results?: Record<string, unknown>[]; success?: boolean }>
}

export function d1Driver(config: {
	accountId: string
	databaseId: string
	apiToken: string
}): Driver {
	const endpoint =
		`https://api.cloudflare.com/client/v4/accounts/${config.accountId}` +
		`/d1/database/${config.databaseId}/query`

	async function send(sql: string, params: SqlValue[]): Promise<Record<string, unknown>[]> {
		const response = await fetch(endpoint, {
			body: JSON.stringify({ params, sql }),
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
