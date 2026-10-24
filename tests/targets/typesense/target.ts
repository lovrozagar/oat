import { createHmac } from "node:crypto"
import { answers, type Target } from "../target.ts"

/*
 * Typesense on a fresh install has only the bootstrap admin key from compose.yml. Each tenant is a
 * collection prefix: alpha's documents live in alpha_books, beta's in beta_books. Alpha is the
 * operator and holds the bootstrap key, which also manages keys; beta holds a key the keys API
 * scopes to documents in beta_.* collections. The viewer holds a scoped search key, the HMAC
 * Typesense derives client-side from a search-only parent key on alpha_.*, so every write it sends
 * must be refused.
 */

const BOOTSTRAP_KEY = "oat-bootstrap-key"

/* One schema for both tenants: every field the run filters or sorts on is indexed for it. */
const BOOK_FIELDS = [
	{ name: "title", type: "string", sort: true },
	{ name: "author", type: "string", facet: true },
	{ name: "year", type: "int32" },
	{ name: "rating", type: "float" },
	{ name: "in_stock", type: "bool" },
]

async function call(baseUrl: string, path: string, body: unknown): Promise<Record<string, unknown>> {
	const response = await fetch(`${baseUrl}${path}`, {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json", "x-typesense-api-key": BOOTSTRAP_KEY },
		method: "POST",
	})
	const text = await response.text()
	if (!response.ok) throw new Error(`POST ${path} answered ${response.status}: ${text}`)
	return JSON.parse(text) as Record<string, unknown>
}

/** A key restricted to `actions` on the collections whose names match `collections`. */
async function scopedKey(
	baseUrl: string,
	key: { description: string; actions: string[]; collections: string[] },
): Promise<string> {
	const { value } = await call(baseUrl, "/keys", key)
	return String(value)
}

/** Typesense's scoped search key: base64(HMAC-SHA256 digest, the parent key's prefix, the embedded params). */
function scopedSearchKey(parent: string, embedded: Record<string, unknown>): string {
	const params = JSON.stringify(embedded)
	const digest = createHmac("sha256", parent).update(params).digest("base64")
	return Buffer.from(`${digest}${parent.slice(0, 4)}${params}`).toString("base64")
}

const target: Target = {
	baseUrl: "http://127.0.0.1:18108",
	readyWithinMs: 120_000,
	async prepare(baseUrl) {
		await answers(`${baseUrl}/health`, 120_000, (status) => status === 200)
		for (const tenant of ["alpha", "beta"])
			await call(baseUrl, "/collections", { fields: BOOK_FIELDS, name: `${tenant}_books` })
		const searchOnly = await scopedKey(baseUrl, {
			actions: ["documents:search"],
			collections: ["alpha_.*"],
			description: "oat viewer parent",
		})
		return {
			TYPESENSE_URL: baseUrl,
			TYPESENSE_ADMIN_KEY: BOOTSTRAP_KEY,
			TYPESENSE_BETA_KEY: await scopedKey(baseUrl, {
				actions: ["documents:*", "collections:get"],
				collections: ["beta_.*"],
				description: "oat beta",
			}),
			TYPESENSE_VIEWER_KEY: scopedSearchKey(searchOnly, { filter_by: "in_stock:true" }),
		}
	},
}

export default target
