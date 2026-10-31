import { defineConfig, env } from "../../../src/index.ts"

/*
 * Typesense 30.2 (spec vendored from typesense/typesense-api-spec openapi.yml at 9963d6c, the last
 * commit before the v30.2 release). Every operation takes the api_key_header scheme
 * (X-TYPESENSE-API-KEY), one key per principal: alpha the bootstrap key, beta a key scoped to
 * beta_.* collections, the viewer a scoped search key (target.ts).
 *
 * Scope: documents in a tenant's collection, API keys, and the collections a tenant can read.
 * The search route is the documents' list; each row wraps its document, which `recordPath`
 * points inside (`$.hits[*].document`). No alias oat knows names Typesense's filter parameter, so
 * `x-query.params` does: the filter checks run through `filter_by`. Collection writes stay out of
 * the document (`allow`): the run works inside the collections target.ts made.
 */

/* What alpha_books and beta_books index (target.ts): the document a create sends and a read answers. */
const BOOK = {
	type: "object",
	required: ["title", "author", "year", "rating", "in_stock"],
	properties: {
		id: { type: "string", readOnly: true },
		title: { type: "string" },
		author: { type: "string" },
		year: { type: "integer", minimum: -2147483648, maximum: 2147483647 },
		rating: { type: "number" },
		in_stock: { type: "boolean" },
	},
}
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
/* A tenant's documents live in its own collection, which its key is scoped to. */
const TENANT = { "x-tenant": "collectionName" }

const GRADED = [
	"indexDocument",
	"searchCollection",
	"getDocument",
	"updateDocument",
	"deleteDocument",
	"createKey",
	"getKeys",
	"getKey",
	"deleteKey",
	"getCollections",
	"getCollection",
]

export default defineConfig({
	spec: "./openapi.yml",
	baseUrl: env("TYPESENSE_URL"),
	overlay: {
		/* Typesense answers a key's value only when it creates it (getKey: "Only the key prefix is
		 * returned when you retrieve a key"), a secret by design. The document should mark it writeOnly
		 * and does not; this says what it should. */
		schemas: { ApiKeySchema: { properties: { value: { type: "string", writeOnly: true } } } },
		operations: {
			indexDocument: { ...TENANT, requestBody: json(BOOK), responses: { "201": json(BOOK) } },
			getDocument: { ...TENANT, responses: { "200": json(BOOK) } },
			updateDocument: { ...TENANT, requestBody: json({ ...BOOK, required: [] }), responses: { "200": json(BOOK) } },
			deleteDocument: { ...TENANT, responses: { "200": json(BOOK) } },
			searchCollection: {
				...TENANT,
				// The document declares one exploded `searchParameters` object; these are the members a
				// listing uses, as the query parameters it puts on the wire.
				parameters: [
					{ name: "collectionName", in: "path", required: true, schema: { type: "string" } },
					{ name: "q", in: "query", required: true, schema: { type: "string", default: "*" } },
					{ name: "query_by", in: "query", required: true, schema: { type: "string", default: "title,author" } },
					{ name: "filter_by", in: "query", schema: { type: "string" } },
					{ name: "sort_by", in: "query", schema: { type: "string" } },
					{ name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
					{ name: "per_page", in: "query", schema: { type: "integer", minimum: 0, maximum: 250, default: 10 } },
					/* By default Typesense drops tokens until something matches; the run asks for every token. */
					{ name: "drop_tokens_threshold", in: "query", required: true, schema: { type: "integer", const: 0 } },
				],
				"x-entity": { name: "document", action: "list", recordPath: "$.hits[*].document" },
				"x-query": {
					params: { filter: "filter_by" },
					grammar: {
						term: "{field}:{op}{value}",
						ops: { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" },
						combine: { join: " && " },
					},
					sortGrammar: { term: "{field}:{direction}", asc: "asc", desc: "desc", join: "," },
					// Closed lists, as Typesense 30.2 answers them: `!=` applies to a float and a bool, and
					// `>` / `<` on a bool is a 400 ("Value of filter field `in_stock` must be `true` or `false`").
					filterable: [
						{ field: "year", type: "number", ops: ["eq", "neq", "gt", "gte", "lt", "lte"] },
						{ field: "rating", type: "number", ops: ["eq", "neq", "gt", "gte", "lt", "lte"] },
						{ field: "in_stock", type: "boolean", ops: ["eq", "neq"] },
					],
					sortable: [
						{ field: "year", type: "number" },
						{ field: "rating", type: "number" },
						{ field: "title", type: "string" },
					],
					searchable: ["title", "author"],
					selectable: [],
					maxSortKeys: 3,
					maxLimit: 250,
				},
			},
		},
	},
	security: { api_key_header: { static: "{principal.key}" } },
	principals: {
		alpha: { tenant: "alpha", scope: { collectionName: "alpha_books" }, key: env("TYPESENSE_ADMIN_KEY") },
		beta: { tenant: "beta", scope: { collectionName: "beta_books" }, key: env("TYPESENSE_BETA_KEY") },
		viewer: {
			tenant: "alpha",
			scope: { collectionName: "alpha_books" },
			readOnly: true,
			key: env("TYPESENSE_VIEWER_KEY"),
		},
	},
	ops: GRADED,
	allow: GRADED,
})
