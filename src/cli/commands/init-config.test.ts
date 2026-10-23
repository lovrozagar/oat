import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { configProblems } from "../../config/validate.ts"
import { specView, securityProblems } from "../../credentials/validate/security.ts"
import { buildSpec } from "../../reference/spec/build.ts"
import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { anyrow, cloudflare, everyScheme, immich, keycloak } from "../../spec/security/__fixtures__/documents.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { renderInitConfig } from "./init-config.ts"

/* The config `oat init` writes, from each real-world security shape: exact text, then loaded and validated. */

const render = (doc: OpenApiDocument) => renderInitConfig(doc, { out: "oat.config.ts", spec: "./openapi.json" })

const HEAD = `// Written by oat init from ./openapi.json. Set each env() variable, then run: oat doctor --config oat.config.ts
import { defineConfig, env } from "@lovrozagar/oat"

export default defineConfig({
	spec: "./openapi.json",
	baseUrl: env("OAT_BASE_URL"),
`

const PRINCIPALS = `	principals: {
		// one principal; a second with a different tenant enables the isolation checks
		alpha: {},
	},
})
`

const UNTESTED = "Operations that need only it are reported untested."

/* A document of `schemes`, its operations each needing what `needs` says. */
const secured = (
	schemes: Record<string, unknown>,
	needs: Record<string, Array<Record<string, string[]>>> = {},
): OpenApiDocument => ({
	components: { securitySchemes: schemes },
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: Object.fromEntries(
		Object.entries(needs).map(([id, security]) => [`/${id}`, { get: { operationId: id, responses: {}, security } }]),
	),
})

/* One oauth2 flow, its scopes and URLs. */
const flows = (flow: string, extra: Record<string, unknown> = {}) => ({ flows: { [flow]: { scopes: {}, ...extra } } })

/* Grants oat runs and one it cannot, a name long enough to wrap, a two-line description, two http schemes it cannot send. */
const grants = secured(
	{
		anExtremelyLongBasicAuthenticationSchemeName: { scheme: "basic", type: "http" },
		code: { ...flows("authorizationCode", { authorizationUrl: "/authorize" }), type: "oauth2" },
		pw: { ...flows("password", { tokenUrl: "https://auth.test/token" }), type: "oauth2" },
		token: { description: "First line.\nSecond line.", scheme: "bearer", type: "http" },
		weird: { scheme: "negotiate", type: "http" },
		untyped: { name: "x" },
	},
	{
		"admin.get": [{ code: ["admin"] }],
		"many.get": [{ pw: Array.from({ length: 9 }, (_, index) => `scope:number-${index}`) }],
	},
)

/* The text, its import pointed at this checkout, loaded from a fresh folder with every env var it names set. */
async function load(doc: OpenApiDocument): Promise<Record<string, unknown>> {
	const { env, text } = render(doc)
	for (const name of env) vi.stubEnv(name, name === "OAT_BASE_URL" ? "http://api.test" : `value-of-${name}`)
	const index = pathToFileURL(join(import.meta.dirname, "..", "..", "index.ts")).href
	const file = join(mkdtempSync(join(tmpdir(), "oat-init-")), "oat.config.ts")
	writeFileSync(file, text.replace('"@lovrozagar/oat"', JSON.stringify(index)))
	return ((await import(pathToFileURL(file).href)) as { default: Record<string, unknown> }).default
}

describe("renderInitConfig on real-world documents", () => {
	it("anyrow: a scoped API key in Authorization and a JWT with a sign-in operation", () => {
		const config = render(anyrow)
		expect(config.text).toBe(`${HEAD}	security: {
		// apiKey in header Authorization. Send \`ApiKey <key>\`.
		// add format: "<Prefix> {credential}" if the server expects a prefix
		// holds: ["rows:read"], // the scopes this credential carries; operations needing scopes it lacks are untested
		apiKey: { static: env("OAT_API_KEY_KEY") },
		// http bearer (JWT) in header Authorization: Bearer {credential}
		// or sign in: login: { steps: [{ operationId: "auth.login", body: {} }], from: "$.access_token" }
		jwt: { static: env("OAT_JWT_TOKEN") },
	},
${PRINCIPALS}`)
		expect(config).toMatchObject({
			env: ["OAT_BASE_URL", "OAT_API_KEY_KEY", "OAT_JWT_TOKEN"],
			schemes: 2,
			unsupported: [],
		})
	})

	it("immich: any of a bearer token, a session cookie or an API key header, none colliding", () => {
		const config = render(immich)
		expect(config.text).toBe(`${HEAD}	security: {
		// apiKey in header x-api-key
		api_key: { static: env("OAT_API_KEY_KEY") },
		// http bearer in header Authorization: Bearer {credential}
		bearer: { static: env("OAT_BEARER_TOKEN") },
		// apiKey in cookie immich_access_token
		cookie: { static: env("OAT_COOKIE_KEY") },
	},
${PRINCIPALS}`)
		expect(config.env).toEqual(["OAT_BASE_URL", "OAT_API_KEY_KEY", "OAT_BEARER_TOKEN", "OAT_COOKIE_KEY"])
	})

	it("cloudflare: an email and a key together, or a token, each its own recipe", () => {
		expect(render(cloudflare).text).toBe(`${HEAD}	security: {
		// apiKey in header X-Auth-Email
		api_email: { static: env("OAT_API_EMAIL_KEY") },
		// apiKey in header X-Auth-Key
		api_key: { static: env("OAT_API_KEY_KEY") },
		// http bearer in header Authorization: Bearer {credential}
		api_token: { static: env("OAT_API_TOKEN_TOKEN") },
	},
${PRINCIPALS}`)
	})
})

describe("renderInitConfig on every scheme type", () => {
	it("every scheme type: unsupported ones as a comment naming the type and the reason, an oauth2 grant oat runs", () => {
		const config = render(everyScheme)
		expect(config.text).toBe(`${HEAD}	security: {
		// http basic in header Authorization: Basic base64(username:password)
		basic: { static: { username: env("OAT_BASIC_USERNAME"), password: env("OAT_BASIC_PASSWORD") } },
		// http bearer (JWT) in header Authorization: Bearer {credential}
		bearer: { static: env("OAT_BEARER_TOKEN") },
		// broken: apiKey, not sent by oat — an apiKey scheme needs \`in\` (header, query or cookie) and a \`name\`. ${UNTESTED}
		// apiKey in cookie session
		cookie: { static: env("OAT_COOKIE_KEY") },
		// digest: http digest, not sent by oat — http digest needs a challenge-response round trip. ${UNTESTED}
		// apiKey in header X-Key
		header: { static: env("OAT_HEADER_KEY") },
		// mtls: mutualTLS, not sent by oat — mutualTLS is a TLS client certificate, not a request credential. ${UNTESTED}
		// oauth2 clientCredentials, token from /token
		oauth: {
			oauth2: {
				flow: "clientCredentials",
				clientId: env("OAT_OAUTH_CLIENT_ID"),
				clientSecret: env("OAT_OAUTH_CLIENT_SECRET"),
				scopes: ["read", "write"],
			},
		},
		// openIdConnect in header Authorization: Bearer {credential}
		// a token from https://auth.test/.well-known/openid-configuration
		oidc: { static: env("OAT_OIDC_TOKEN") },
		// apiKey in query api_key
		query: { static: env("OAT_QUERY_KEY") },
		// strange: kerberos, not sent by oat — scheme type "kerberos" is not one oat knows. ${UNTESTED}
	},
${PRINCIPALS}`)
		expect(config.schemes).toBe(7)
		expect(config.unsupported).toEqual([
			{ name: "broken", type: "apiKey", why: "an apiKey scheme needs `in` (header, query or cookie) and a `name`" },
			{ name: "digest", type: "http digest", why: "http digest needs a challenge-response round trip" },
			{ name: "mtls", type: "mutualTLS", why: "mutualTLS is a TLS client certificate, not a request credential" },
			{ name: "strange", type: "kerberos", why: 'scheme type "kerberos" is not one oat knows' },
		])
	})
})

describe("renderInitConfig's base URL and env names", () => {
	it("keycloak: no scheme declared, so the overlay stub is a comment and env is imported only for baseUrl", () => {
		const stub = `	// The document declares no security scheme. If the API needs a credential, declare it:
	// overlay: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }] },
	// security: { bearer: { static: env("OAT_BEARER_TOKEN") } },
`
		expect(render(keycloak)).toEqual({
			env: ["OAT_BASE_URL"],
			schemes: 0,
			text: `${HEAD}${stub}${PRINCIPALS}`,
			unsupported: [],
		})
		const served = render({ ...keycloak, servers: [{ url: "https://kc.test/admin" }] })
		expect(served.env).toEqual([])
		expect(served.text).toBe(`// Written by oat init from ./openapi.json. Run: oat doctor --config oat.config.ts
import { defineConfig } from "@lovrozagar/oat"

export default defineConfig({
	spec: "./openapi.json",
	baseUrl: "https://kc.test/admin",
${stub}${PRINCIPALS}`)
	})

	it("names a colliding env var with _2, and quotes a scheme name that is not an identifier", () => {
		const doc = secured({
			"api-key": { in: "header", name: "X-A", type: "apiKey" },
			apiKey: { in: "header", name: "X-B", type: "apiKey" },
			api_key: { in: "header", name: "X-C", type: "apiKey" },
		})
		const config = render(doc)
		expect(config.text).toContain(`		"api-key": { static: env("OAT_API_KEY_KEY") },
		// apiKey in header X-B
		apiKey: { static: env("OAT_API_KEY_2_KEY") },
		// apiKey in header X-C
		api_key: { static: env("OAT_API_KEY_3_KEY") },
`)
		expect(config.env).toEqual(["OAT_BASE_URL", "OAT_API_KEY_KEY", "OAT_API_KEY_2_KEY", "OAT_API_KEY_3_KEY"])
	})

	it("takes the first absolute server URL, with its variables' defaults", () => {
		const servers = [
			{ url: "/relative" },
			{ url: "https://{tenant}.api.test", variables: { tenant: {} } },
			{
				url: "https://{region}.api.test/v{version}",
				variables: { region: { default: "eu" }, version: { default: "2" } },
			},
		]
		const config = render({ ...keycloak, servers } as OpenApiDocument)
		expect(config.text).toContain(`	baseUrl: "https://eu.api.test/v2",\n`)
		expect(render({ ...keycloak, servers: [{ url: "ftp://files.test" }] }).env).toEqual(["OAT_BASE_URL"])
	})
})

describe("renderInitConfig's grants and line wrapping", () => {
	it("writes a password grant with its secret commented, a token for a grant oat cannot run, and wraps long lines", () => {
		const config = render(grants)
		expect(config.text).toBe(`${HEAD}	security: {
		// http basic in header Authorization: Basic base64(username:password)
		anExtremelyLongBasicAuthenticationSchemeName: {
			static: {
				username: env("OAT_AN_EXTREMELY_LONG_BASIC_AUTHENTICATION_SCHEME_NAME_USERNAME"),
				password: env("OAT_AN_EXTREMELY_LONG_BASIC_AUTHENTICATION_SCHEME_NAME_PASSWORD"),
			},
		},
		// oauth2 authorizationCode in header Authorization: Bearer {credential}
		// oat performs only clientCredentials and password grants; supply a token obtained elsewhere
		// holds: ["admin"], // the scopes this credential carries; operations needing scopes it lacks are untested
		code: { static: env("OAT_CODE_TOKEN") },
		// oauth2 password, token from https://auth.test/token
		pw: {
			oauth2: {
				flow: "password",
				clientId: env("OAT_PW_CLIENT_ID"),
				// clientSecret: env("OAT_PW_CLIENT_SECRET"),
				username: env("OAT_PW_USERNAME"),
				password: env("OAT_PW_PASSWORD"),
				scopes: [
					"scope:number-0",
					"scope:number-1",
					"scope:number-2",
					"scope:number-3",
					"scope:number-4",
					"scope:number-5",
					"scope:number-6",
					"scope:number-7",
					"scope:number-8",
				],
			},
		},
		// http bearer in header Authorization: Bearer {credential}. First line.
		token: { static: env("OAT_TOKEN_TOKEN") },
		// weird: http negotiate, not sent by oat — http scheme "negotiate" is not one oat can send. ${UNTESTED}
		// untyped: no type, not sent by oat — scheme type "undefined" is not one oat knows. ${UNTESTED}
	},
${PRINCIPALS}`)
		expect(config.env).not.toContain("OAT_PW_CLIENT_SECRET")
	})
})

describe("renderInitConfig on odd declarations", () => {
	it("reads odd declarations: a nameless stem, oauth2 without flows or scopes, a null scheme, http without a scheme", () => {
		const doc = secured({
			"-": { in: "header", name: "X", type: "apiKey" },
			bare: { type: "oauth2" },
			cc: { flows: { clientCredentials: { scopes: {}, tokenUrl: "/t" } }, type: "oauth2" },
			nothing: null,
			plain: { type: "http" },
		})
		expect(render(doc).text).toBe(`${HEAD}	security: {
		// apiKey in header X
		"-": { static: env("OAT_SCHEME_KEY") },
		// oauth2 in header Authorization: Bearer {credential}
		// oat performs only clientCredentials and password grants; supply a token obtained elsewhere
		bare: { static: env("OAT_BARE_TOKEN") },
		// oauth2 clientCredentials, token from /t
		cc: {
			oauth2: {
				flow: "clientCredentials",
				clientId: env("OAT_CC_CLIENT_ID"),
				clientSecret: env("OAT_CC_CLIENT_SECRET"),
			},
		},
		// nothing: no type, not sent by oat — the scheme is not an object. ${UNTESTED}
		// plain: http, not sent by oat — http scheme "" is not one oat can send. ${UNTESTED}
	},
${PRINCIPALS}`)
	})
})

describe("the rendered config", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	const documents: Array<[string, OpenApiDocument]> = [
		["the reference document", buildSpec() as OpenApiDocument],
		["anyrow", anyrow],
		["immich", immich],
		["cloudflare", cloudflare],
		["everyScheme", everyScheme],
		["keycloak", keycloak],
	]

	it.each(documents)("loads and passes configProblems and securityProblems against %s", async (_, raw) => {
		const { doc } = dereference(raw)
		const config = await load(doc)
		expect(configProblems(config, { forRun: true })).toEqual([])
		expect(securityProblems(config, specView(buildModel(doc), doc))).toEqual([])
	})
})

describe("renderInitConfig and the roots a run cannot create", () => {
	it("stubs a scope for each prefix root no create makes, naming the operations it unlocks", () => {
		const { doc } = dereference(buildSpec() as OpenApiDocument)
		const { text } = renderInitConfig(doc, { out: "oat.config.ts", spec: "openapi.json" })
		expect(text).toContain(
			[
				"\t\talpha: {",
				"\t\t\t// no create operation makes these path parameters; set each to one this principal can reach:",
				'\t\t\t// scope: { project_id: "" },',
				"\t\t\t// project_id unlocks table.list, table.create, table.get, table.delete and 20 more",
				"\t\t},",
			].join("\n"),
		)
		/* An id a flow yields (the invite's token, its grant) is no root to stub. */
		expect(text).not.toMatch(/(token|grant_id|\bid): ""|(token|grant_id) unlocks/)
	})

	it("names every operation a root unlocks when there are few", () => {
		const rows = { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" }
		const list = {
			get: {
				operationId: "widget.list",
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				responses: { "200": { content: { "application/json": { schema: rows } }, description: "ok" } },
			},
		}
		const paths = { "/orgs/{org_id}/widgets": list }
		const doc = { info: { title: "t", version: "1" }, openapi: "3.1.0", paths } as unknown as OpenApiDocument
		const { text } = renderInitConfig(dereference(doc).doc, { out: "oat.config.ts", spec: "openapi.json" })
		expect(text).toContain("\t\t\t// org_id unlocks widget.list\n")
	})

	it("writes an empty principal when every route can be seeded", () => {
		const { text } = renderInitConfig(dereference(keycloak).doc, { out: "oat.config.ts", spec: "openapi.json" })
		expect(text).toContain("\t\talpha: {},")
	})
})

/** The config init writes for a document served at `spec` whose only server is `url`. */
const servedAt = (url: string, spec: string): string =>
	renderInitConfig({ ...keycloak, servers: [{ url }] }, { out: "oat.config.ts", spec }).text

describe("renderInitConfig and a relative server", () => {
	it("resolves it against the document's URL, as OpenAPI says, and leaves it to env for a file", () => {
		const remote = "https://petstore.test/api/v3/openapi.json"
		expect(servedAt("/api/v3", remote)).toContain('baseUrl: "https://petstore.test/api/v3",')
		expect(servedAt("./v4", remote)).toContain('baseUrl: "https://petstore.test/api/v3/v4",')
		expect(servedAt("v4", remote)).toContain('baseUrl: "https://petstore.test/api/v3/v4",')
		expect(servedAt("/api/v3", "./openapi.json")).toContain('baseUrl: env("OAT_BASE_URL"),')
	})
})
