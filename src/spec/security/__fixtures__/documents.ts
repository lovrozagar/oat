import type { OpenApiDocument } from "../../types.ts"

/* Real-world security shapes, cut down to what the model reads. */

const ok = { "200": { description: "ok" } }
const op = (operationId: string, security?: Array<Record<string, string[]>>): Record<string, unknown> => ({
	operationId,
	responses: ok,
	...(security === undefined ? {} : { security }),
})

const doc = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}): OpenApiDocument =>
	({ info: { title: "security", version: "1" }, openapi: "3.1.0", paths, ...extra }) as OpenApiDocument

/** anyrow: a JWT for people, and a scoped API key in the same Authorization header for machines. */
export const anyrow = doc(
	{
		"/v1/auth/login": { post: op("auth.login", []) },
		"/v1/me": { get: op("me.get") },
		"/v1/rows": { get: op("row.list", [{ jwt: [] }, { apiKey: ["rows:read"] }]) },
	},
	{
		components: {
			securitySchemes: {
				apiKey: { description: "Send `ApiKey <key>`.", in: "header", name: "Authorization", type: "apiKey" },
				jwt: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
			},
		},
		security: [{ jwt: [] }],
	},
)

/** Immich: any one of a bearer token, a session cookie or an API key header. */
export const immich = doc(
	{ "/api/assets": { get: op("asset.list") }, "/api/server/ping": { get: op("server.ping", []) } },
	{
		components: {
			securitySchemes: {
				api_key: { in: "header", name: "x-api-key", type: "apiKey" },
				bearer: { scheme: "Bearer", type: "http" },
				cookie: { in: "cookie", name: "immich_access_token", type: "apiKey" },
			},
		},
		security: [{ bearer: [] }, { cookie: [] }, { api_key: [] }],
	},
)

/** Cloudflare: an email and a key together, or a token alone. */
export const cloudflare = doc(
	{ "/zones": { get: op("zones.list") } },
	{
		components: {
			securitySchemes: {
				api_email: { in: "header", name: "X-Auth-Email", type: "apiKey" },
				api_key: { in: "header", name: "X-Auth-Key", type: "apiKey" },
				api_token: { scheme: "bearer", type: "http" },
			},
		},
		security: [{ api_email: [], api_key: [] }, { api_token: [] }],
	},
)

/** Keycloak admin: every route needs a token, and the document declares no scheme at all. */
export const keycloak = doc({ "/admin/realms": { get: op("realms.list") } })

/** One of every scheme type, for the scheme reader. */
export const everyScheme = doc(
	{
		"/a": { get: op("a.get", [{ basic: [] }, {}]) },
		"/b": { get: op("b.get", [{ oauth: ["read", "write"], mtls: [] }]) },
		"/c": { get: op("c.get", [{ missing: [] }]) },
	},
	{
		components: {
			securitySchemes: {
				basic: { scheme: "basic", type: "http" },
				bearer: { bearerFormat: "JWT", deprecated: true, scheme: "bearer", type: "http" },
				broken: { in: "header", type: "apiKey" },
				cookie: { in: "cookie", name: "session", type: "apiKey" },
				digest: { scheme: "digest", type: "http" },
				header: { in: "header", name: "X-Key", type: "apiKey" },
				mtls: { type: "mutualTLS" },
				oauth: {
					flows: {
						authorizationCode: {
							authorizationUrl: "https://auth.test/authorize",
							scopes: { read: "read" },
							tokenUrl: "https://auth.test/token",
						},
						clientCredentials: {
							refreshUrl: "https://auth.test/refresh",
							scopes: { read: "read" },
							tokenUrl: "/token",
						},
						deviceAuthorization: {
							deviceAuthorizationUrl: "https://auth.test/device",
							scopes: {},
							tokenUrl: "https://auth.test/token",
						},
						implicit: { authorizationUrl: "https://auth.test/authorize", scopes: {} },
						password: { scopes: { write: "write" }, tokenUrl: "https://auth.test/token" },
					},
					oauth2MetadataUrl: "https://auth.test/.well-known/oauth-authorization-server",
					type: "oauth2",
				},
				oidc: { openIdConnectUrl: "https://auth.test/.well-known/openid-configuration", type: "openIdConnect" },
				query: { in: "query", name: "api_key", type: "apiKey" },
				strange: { type: "kerberos" },
			},
		},
	},
)
