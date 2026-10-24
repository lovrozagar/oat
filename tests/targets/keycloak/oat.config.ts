import { defineConfig, env } from "../../../src/index.ts"

/*
 * Keycloak 26.8.1, Admin REST API (spec vendored from keycloak.org/docs-api/26.8.1/rest-api/openapi.json).
 * The document declares no security scheme and no operationIds, so oat names each operation
 * `METHOD /path`. The overlay declares the bearer token Keycloak takes as the OAuth 2
 * client-credentials grant that issues it, so oat mints and renews each principal's token at the
 * master realm's token endpoint itself.
 *
 * Scope: the read surface of a realm's users, groups, clients, roles and client scopes, and the
 * writes of its users and groups, as a delegated realm admin (alpha), a peer realm's admin (beta)
 * and a read-only operator (viewer) see it. A create answers 201 with the new id only in its
 * Location header, which oat reads the id from.
 */

const READS = [
	"GET /admin/realms/{realm}/users",
	"GET /admin/realms/{realm}/users/count",
	"GET /admin/realms/{realm}/users/{user-id}",
	"GET /admin/realms/{realm}/groups",
	"GET /admin/realms/{realm}/groups/count",
	"GET /admin/realms/{realm}/groups/{group-id}",
	"GET /admin/realms/{realm}/clients",
	"GET /admin/realms/{realm}/clients/{client-uuid}",
	"GET /admin/realms/{realm}/roles",
	"GET /admin/realms/{realm}/roles/{role-name}",
	"GET /admin/realms/{realm}/client-scopes",
	"GET /admin/realms/{realm}/client-scopes/{client-scope-id}",
]

const WRITES = [
	"POST /admin/realms/{realm}/users",
	"PUT /admin/realms/{realm}/users/{user-id}",
	"DELETE /admin/realms/{realm}/users/{user-id}",
	"POST /admin/realms/{realm}/groups",
	"PUT /admin/realms/{realm}/groups/{group-id}",
	"DELETE /admin/realms/{realm}/groups/{group-id}",
]

const json = (schema: object) => ({ content: { "application/json": { schema } }, required: true })

/* A user a create makes: a lowercase username, an address, enabled. */
const USER = {
	type: "object",
	properties: {
		username: { type: "string", pattern: "^[a-z][a-z0-9-]{2,20}$" },
		email: { type: "string", format: "email" },
		firstName: { type: "string", maxLength: 40 },
		enabled: { type: "boolean" },
	},
	required: ["username", "email", "enabled"],
}

/* A top-level group: its name alone. */
const GROUP = {
	type: "object",
	properties: { name: { type: "string", pattern: "^[a-z][a-z0-9-]{2,20}$" } },
	required: ["name"],
}

/* No order, select or free-text parameter on any of these lists. */
const NO_QUERY = { sortable: [], searchable: [], selectable: [] }

export default defineConfig({
	spec: "./openapi.json",
	baseUrl: env("KEYCLOAK_URL"),
	overlay: {
		securitySchemes: {
			bearer: {
				type: "oauth2",
				flows: { clientCredentials: { tokenUrl: "/realms/master/protocol/openid-connect/token", scopes: {} } },
			},
		},
		security: [{ bearer: [] }],
		/* The document's representations take every field Keycloak has, none of them typed: the
		 * writes send only what a create needs, an email as an address, and never an id. */
		operations: {
			/* A realm holds one user per username and per email: each cohort member needs its own. */
			"POST /admin/realms/{realm}/users": { requestBody: json(USER), "x-unique": [["username"], ["email"]] },
			"PUT /admin/realms/{realm}/users/{user-id}": { requestBody: json({ ...USER, required: [] }) },
			"POST /admin/realms/{realm}/groups": { requestBody: json(GROUP) },
			"PUT /admin/realms/{realm}/groups/{group-id}": { requestBody: json(GROUP) },
		},
	},
	security: {
		bearer: {
			oauth2: { flow: "clientCredentials", clientId: "{principal.clientId}", clientSecret: "{principal.secret}" },
		},
	},
	principals: {
		alpha: {
			tenant: "oat-a",
			scope: { realm: "oat-a" },
			clientId: env("KEYCLOAK_ALPHA_CLIENT_ID"),
			secret: env("KEYCLOAK_ALPHA_SECRET"),
		},
		beta: {
			tenant: "oat-b",
			scope: { realm: "oat-b" },
			clientId: env("KEYCLOAK_BETA_CLIENT_ID"),
			secret: env("KEYCLOAK_BETA_SECRET"),
		},
		viewer: {
			tenant: "oat-a",
			scope: { realm: "oat-a" },
			readOnly: true,
			clientId: env("KEYCLOAK_VIEWER_CLIENT_ID"),
			secret: env("KEYCLOAK_VIEWER_SECRET"),
		},
	},
	allow: [...READS, ...WRITES],
	ops: [...READS, ...WRITES],
	entities: {
		// `username`, `email`, `firstName` and `lastName` match substrings unless `exact=true`, and `q`
		// searches attributes as `key:value`: only the exact-match parameters are filterable.
		user: {
			query: {
				grammar: "equality",
				filterable: [
					{ field: "enabled", type: "boolean", ops: ["eq"] },
					{ field: "emailVerified", type: "boolean", ops: ["eq"] },
				],
				...NO_QUERY,
			},
		},
		group: { query: { filterable: [], ...NO_QUERY } },
		client: {
			query: { grammar: "equality", filterable: [{ field: "clientId", type: "string", ops: ["eq"] }], ...NO_QUERY },
		},
		role: { query: { filterable: [], ...NO_QUERY } },
		"client-scope": { query: { filterable: [], ...NO_QUERY } },
	},
})
