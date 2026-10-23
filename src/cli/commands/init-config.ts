import { rootsOf } from "../../report/console/roots.ts"
import { prefixRoots } from "../../spec/graph/roots.ts"
import { buildModel } from "../../spec/graph/build.ts"
import { listEndpoints } from "../../spec/endpoints.ts"
import { type Placement, placementOf } from "../../spec/security/placement.ts"
import { resolveSecurity, type Requirement } from "../../spec/security/requirements.ts"
import { type FlowName, readSchemes, type SecurityScheme } from "../../spec/security/schemes.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { type Field, fieldLines, quote } from "./init-code.ts"

/*
 * The starter config `oat init` writes from a document: one credential recipe per security scheme,
 * each reading its secret from an env var, and one principal. Pure: the command does the IO.
 * The text is laid out as oxfmt lays it out (`init-code.ts`).
 */

/** A scheme the config cannot hold a recipe for, with its declared type and why oat cannot send it. */
export interface UnsupportedScheme {
	name: string
	type: string
	why: string
}

export interface InitConfig {
	text: string
	/** Every env var the config reads, in the order it reads them. */
	env: string[]
	/** How many schemes got a recipe. */
	schemes: number
	unsupported: UnsupportedScheme[]
}

const UNTESTED = "Operations that need only it are reported untested."
const OWNED_GRANTS = "oat performs only clientCredentials and password grants; supply a token obtained elsewhere"
const HOLDS = "the scopes this credential carries; operations needing scopes it lacks are untested"
const SIGN_IN = /login|token|session/i

/** Each scheme's env var stem, `OAT_<NAME>`, with `_2`, `_3` for a later scheme whose stem is taken. */
function envStems(): (scheme: string) => string {
	const taken = new Set<string>()
	return (scheme) => {
		const words = scheme
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.replace(/[^A-Za-z0-9]+/g, "_")
			.replace(/^_|_$/g, "")
		const base = `OAT_${words.toUpperCase() || "SCHEME"}`
		let stem = base
		for (let n = 2; taken.has(stem); n++) stem = `${base}_${n}`
		taken.add(stem)
		return stem
	}
}

/** What the document's operations say about the schemes: scopes each is required with, and a sign-in to suggest. */
interface Usage {
	scopes: (scheme: string) => string[]
	signIn?: string
}

function usageOf(doc: OpenApiDocument): Usage {
	const endpoints = listEndpoints(doc).map((endpoint) => ({ endpoint, security: resolveSecurity(endpoint.op, doc) }))
	const required: Requirement[] = endpoints.flatMap(({ security }) => security.alternatives.flat())
	const signIn = endpoints.find(
		({ endpoint, security }) =>
			endpoint.method === "post" &&
			endpoint.op.operationId !== undefined &&
			SIGN_IN.test(endpoint.path) &&
			security.alternatives.some((alternative) => alternative.length === 0),
	)?.endpoint.op.operationId
	const scopes = (scheme: string) =>
		[...new Set(required.filter((need) => need.scheme === scheme).flatMap((need) => need.scopes))].toSorted()
	return signIn === undefined ? { scopes } : { scopes, signIn }
}

/** A recipe's code, the comments above it, and the env vars it reads. */
interface Recipe {
	value: Field[]
	comments: string[]
	env: string[]
}

const env = (name: string): string => `env(${quote(name)})`
type Supported = Exclude<SecurityScheme, { kind: "unsupported" }>

/** Where a scheme's credential goes, as its placement says: `in header Authorization: Bearer {credential}`. */
function placed(scheme: Supported): string {
	const place = placementOf(scheme) as Placement
	const where = `in ${place.in} ${place.name}`
	if (place.template === "{credential}") return where
	const filled =
		place.encode === "base64" ? place.template.replace("{credential}", "base64(username:password)") : place.template
	return `${where}: ${filled}`
}

/* An API key in the header a bearer token goes in: the server may expect a prefix there, as it does for the token. */
function inPrefixedHeader(scheme: Extract<SecurityScheme, { kind: "apiKey" }>): boolean {
	const own = placementOf(scheme) as Placement
	const bearer = placementOf({ deprecated: false, kind: "bearer", name: scheme.name }) as Placement
	return own.in === bearer.in && own.name.toLowerCase() === bearer.name.toLowerCase()
}

/* A static token or key: what most schemes take, with the scopes it must hold when operations ask for some. */
function staticRecipe(name: string, comments: string[], scopes: readonly string[]): Recipe {
	const holds = scopes.length === 0 ? [] : [`holds: [${scopes.map(quote).join(", ")}], // ${HOLDS}`]
	return { comments: [...comments, ...holds], env: [name], value: [{ key: "static", value: env(name) }] }
}

function oauth2Recipe(scheme: Extract<SecurityScheme, { kind: "oauth2" }>, stem: string, scopes: string[]): Recipe {
	const grant = (["clientCredentials", "password"] as const).find((flow) => scheme.flows[flow]?.tokenUrl !== undefined)
	if (grant === undefined) {
		const flows = Object.keys(scheme.flows) as FlowName[]
		const kind = `oauth2${flows.length === 0 ? "" : ` ${flows.join(", ")}`} ${placed(scheme)}`
		return staticRecipe(`${stem}_TOKEN`, [kind, OWNED_GRANTS], scopes)
	}
	const [id, secret, username, password] = ["CLIENT_ID", "CLIENT_SECRET", "USERNAME", "PASSWORD"].map(
		(suffix) => `${stem}_${suffix}`,
	) as [string, string, string, string]
	const credentials: Field[] =
		grant === "password"
			? [
					{ comment: `clientSecret: ${env(secret)},` },
					{ key: "username", value: env(username) },
					{ key: "password", value: env(password) },
				]
			: [{ key: "clientSecret", value: env(secret) }]
	const fields: Field[] = [
		{ key: "flow", value: quote(grant) },
		{ key: "clientId", value: env(id) },
		...credentials,
		...(scopes.length === 0 ? [] : [{ key: "scopes", value: scopes.map(quote) }]),
	]
	return {
		comments: [`oauth2 ${grant}, token from ${scheme.flows[grant]?.tokenUrl}`],
		env: grant === "password" ? [id, username, password] : [id, secret],
		value: [{ key: "oauth2", value: fields }],
	}
}

/** The recipe a supported scheme gets, with the comments that say where its credential goes. */
function recipeOf(scheme: Supported, stem: string, usage: Usage): Recipe {
	const scopes = usage.scopes(scheme.name)
	switch (scheme.kind) {
		case "bearer": {
			const format = scheme.bearerFormat === undefined ? "" : ` (${scheme.bearerFormat})`
			const login = usage.signIn === undefined ? [] : [signInComment(usage.signIn)]
			return staticRecipe(`${stem}_TOKEN`, [`http bearer${format} ${placed(scheme)}`, ...login], scopes)
		}
		case "basic": {
			const pair: Field[] = [
				{ key: "username", value: env(`${stem}_USERNAME`) },
				{ key: "password", value: env(`${stem}_PASSWORD`) },
			]
			return {
				comments: [`http basic ${placed(scheme)}`],
				env: [`${stem}_USERNAME`, `${stem}_PASSWORD`],
				value: [{ key: "static", value: pair }],
			}
		}
		case "apiKey": {
			const prefix = inPrefixedHeader(scheme)
				? ['add format: "<Prefix> {credential}" if the server expects a prefix']
				: []
			return staticRecipe(`${stem}_KEY`, [`apiKey ${placed(scheme)}`, ...prefix], scopes)
		}
		case "openIdConnect":
			return staticRecipe(
				`${stem}_TOKEN`,
				[`openIdConnect ${placed(scheme)}`, `a token from ${scheme.openIdConnectUrl}`],
				scopes,
			)
		case "oauth2":
			return oauth2Recipe(scheme, stem, scopes)
	}
}

const signInComment = (operationId: string): string =>
	`or sign in: login: { steps: [{ operationId: ${quote(operationId)}, body: {} }], from: "$.access_token" }`

/** The declared type of a scheme oat cannot send, as the document writes it: `mutualTLS`, `http digest`. */
function declaredType(raw: unknown): string {
	const declared = (raw ?? {}) as { type?: unknown; scheme?: unknown }
	if (typeof declared.type !== "string") return "no type"
	return declared.type === "http" ? `http ${String(declared.scheme ?? "")}`.trim() : declared.type
}

/** The first description line of a scheme, as a sentence after its placement. */
function described(raw: unknown): string {
	const description = (raw as { description?: unknown } | undefined)?.description
	const first = typeof description === "string" ? description.split("\n")[0]?.trim() : undefined
	return first === undefined || first === "" ? "" : `. ${first}`
}

/** The first absolute http(s) server URL, its variables filled with their defaults. */
function serverUrl(doc: OpenApiDocument): string | undefined {
	for (const server of doc.servers ?? []) {
		const variables = ((server as { variables?: unknown }).variables ?? {}) as Record<string, { default?: unknown }>
		const url = server.url.replace(/\{([^}]*)\}/g, (whole, name: string) => {
			const fill = variables[name]?.default
			return typeof fill === "string" ? fill : whole
		})
		if (/^https?:\/\/[^{}]+$/.test(url)) return url
	}
	return undefined
}

const NO_SCHEME: readonly Field[] = [
	{ comment: "The document declares no security scheme. If the API needs a credential, declare it:" },
	{
		comment:
			'overlay: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }] },',
	},
	{ comment: 'security: { bearer: { static: env("OAT_BEARER_TOKEN") } },' },
]

const PRINCIPAL = "one principal; a second with a different tenant enables the isolation checks"
const NAMED = 4

/*
 * The principal's body: a commented `scope` for each prefix root no create operation makes, and the
 * operations each one unlocks. Ids a flow yields (an invite's token) are a run's to pick up, not the config's.
 */
function principalStub(doc: OpenApiDocument): Field[] {
	const model = buildModel(doc)
	const prefix = prefixRoots(model)
	const roots = rootsOf(model).required
	if (roots.length === 0) return []
	const unlocks = roots.map((root) => {
		/* A required root is a prefix root, so its operations are always there. */
		const operations = prefix.get(root) as string[]
		const more = operations.length > NAMED ? ` and ${operations.length - NAMED} more` : ""
		return { comment: `${root} unlocks ${operations.slice(0, NAMED).join(", ")}${more}` }
	})
	return [
		{ comment: "no create operation makes these path parameters; set each to one this principal can reach:" },
		{ comment: `scope: { ${roots.map((root) => `${root}: ""`).join(", ")} },` },
		...unlocks,
	]
}

/** The config `oat init` writes for `doc`, read from `spec` and written to `out`. */
export function renderInitConfig(doc: OpenApiDocument, where: { spec: string; out: string }): InitConfig {
	const declared = doc.components?.securitySchemes ?? {}
	const schemes = readSchemes(doc)
	const usage = usageOf(doc)
	const stemOf = envStems()
	const base = serverUrl(doc)
	const names: string[] = base === undefined ? ["OAT_BASE_URL"] : []
	const unsupported: UnsupportedScheme[] = []
	const security: Field[] = []
	for (const scheme of schemes.values()) {
		if (scheme.kind === "unsupported") {
			const type = declaredType(declared[scheme.name])
			unsupported.push({ name: scheme.name, type, why: scheme.unsupported })
			security.push({ comment: `${scheme.name}: ${type}, not sent by oat — ${scheme.unsupported}. ${UNTESTED}` })
			continue
		}
		const recipe = recipeOf(scheme, stemOf(scheme.name), usage)
		const [kind = "", ...rest] = recipe.comments
		names.push(...recipe.env)
		security.push({
			comments: [`${kind}${described(declared[scheme.name])}`, ...rest],
			key: scheme.name,
			value: recipe.value,
		})
	}
	const fields: Field[] = [
		{ key: "spec", value: quote(where.spec) },
		{ key: "baseUrl", value: base === undefined ? env("OAT_BASE_URL") : quote(base) },
		...(schemes.size === 0 ? NO_SCHEME : [{ key: "security", value: security }]),
		{ key: "principals", value: [{ comments: [PRINCIPAL], key: "alpha", value: principalStub(doc) }] },
	]
	const next = `oat doctor --config ${where.out}`
	const header =
		names.length === 0
			? `// Written by oat init from ${where.spec}. Run: ${next}`
			: `// Written by oat init from ${where.spec}. Set each env() variable, then run: ${next}`
	const text = [
		header,
		`import { ${names.length === 0 ? "defineConfig" : "defineConfig, env"} } from "@lovrozagar/oat"`,
		"",
		"export default defineConfig({",
		...fieldLines(fields, 1),
		"})",
		"",
	].join("\n")
	return { env: names, schemes: schemes.size - unsupported.length, text, unsupported }
}
