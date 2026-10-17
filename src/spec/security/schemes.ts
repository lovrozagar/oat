import type { OpenApiDocument } from "../types.ts"

/*
 * The security schemes a document declares, read into what oat needs to send a credential: where it
 * goes and how it is written. A scheme oat cannot send (a TLS client certificate, a digest
 * challenge, a type it does not know, a malformed declaration) is read as unsupported, with why,
 * so an operation that needs one is reported untested instead of sent without it.
 */

export type ApiKeyLocation = "header" | "query" | "cookie"

export type FlowName = "authorizationCode" | "clientCredentials" | "deviceAuthorization" | "implicit" | "password"

export interface OAuthFlow {
	authorizationUrl?: string
	deviceAuthorizationUrl?: string
	refreshUrl?: string
	tokenUrl?: string
	/** The scope names the flow can grant. */
	scopes: string[]
}

interface SchemeBase {
	name: string
	/** OAS 3.2: the scheme is on its way out; still sent. */
	deprecated: boolean
}

export type SecurityScheme = SchemeBase &
	(
		| { kind: "bearer"; bearerFormat?: string }
		| { kind: "basic" }
		/* An API key's location, and the header, query parameter or cookie it is named. */
		| { kind: "apiKey"; in: ApiKeyLocation; param: string }
		| { kind: "oauth2"; flows: Partial<Record<FlowName, OAuthFlow>>; oauth2MetadataUrl?: string }
		| { kind: "openIdConnect"; openIdConnectUrl: string }
		/* Why oat cannot send this scheme. */
		| { kind: "unsupported"; unsupported: string }
	)

const FLOWS: readonly FlowName[] = [
	"authorizationCode",
	"clientCredentials",
	"deviceAuthorization",
	"implicit",
	"password",
]
const FLOW_URLS = ["authorizationUrl", "deviceAuthorizationUrl", "refreshUrl", "tokenUrl"] as const
const LOCATIONS: ReadonlySet<string> = /* @__PURE__ */ new Set(["header", "query", "cookie"])

type Raw = Record<string, unknown>

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

function unsupported(name: string, deprecated: boolean, why: string): SecurityScheme {
	return { deprecated, kind: "unsupported", name, unsupported: why }
}

function readHttp(name: string, raw: Raw, deprecated: boolean): SecurityScheme {
	const scheme = (text(raw.scheme) ?? "").toLowerCase()
	if (scheme === "basic") return { deprecated, kind: "basic", name }
	if (scheme === "bearer") {
		const format = text(raw.bearerFormat)
		return { deprecated, kind: "bearer", name, ...(format === undefined ? {} : { bearerFormat: format }) }
	}
	if (scheme === "digest") return unsupported(name, deprecated, "http digest needs a challenge-response round trip")
	return unsupported(name, deprecated, `http scheme "${scheme}" is not one oat can send`)
}

function readApiKey(name: string, raw: Raw, deprecated: boolean): SecurityScheme {
	const location = text(raw.in)
	const param = text(raw.name)
	if (location === undefined || !LOCATIONS.has(location) || param === undefined) {
		return unsupported(name, deprecated, "an apiKey scheme needs `in` (header, query or cookie) and a `name`")
	}
	return { deprecated, in: location as ApiKeyLocation, kind: "apiKey", name, param }
}

function readFlow(raw: unknown): OAuthFlow {
	const flow = (raw ?? {}) as Raw
	const scopes = flow.scopes !== null && typeof flow.scopes === "object" ? Object.keys(flow.scopes) : []
	const out: OAuthFlow = { scopes }
	for (const key of FLOW_URLS) {
		const url = text(flow[key])
		if (url !== undefined) out[key] = url
	}
	return out
}

function readOAuth2(name: string, raw: Raw, deprecated: boolean): SecurityScheme {
	const declared = (raw.flows ?? {}) as Raw
	const flows: Partial<Record<FlowName, OAuthFlow>> = {}
	for (const flow of FLOWS) if (declared[flow] !== undefined) flows[flow] = readFlow(declared[flow])
	const metadata = text(raw.oauth2MetadataUrl)
	return { deprecated, flows, kind: "oauth2", name, ...(metadata === undefined ? {} : { oauth2MetadataUrl: metadata }) }
}

function readOpenIdConnect(name: string, raw: Raw, deprecated: boolean): SecurityScheme {
	const url = text(raw.openIdConnectUrl)
	if (url === undefined) return unsupported(name, deprecated, "an openIdConnect scheme needs an `openIdConnectUrl`")
	return { deprecated, kind: "openIdConnect", name, openIdConnectUrl: url }
}

function readScheme(name: string, value: unknown): SecurityScheme {
	if (value === null || typeof value !== "object") return unsupported(name, false, "the scheme is not an object")
	const raw = value as Raw
	const deprecated = raw.deprecated === true
	switch (raw.type) {
		case "http":
			return readHttp(name, raw, deprecated)
		case "apiKey":
			return readApiKey(name, raw, deprecated)
		case "oauth2":
			return readOAuth2(name, raw, deprecated)
		case "openIdConnect":
			return readOpenIdConnect(name, raw, deprecated)
		case "mutualTLS":
			return unsupported(name, deprecated, "mutualTLS is a TLS client certificate, not a request credential")
		default:
			return unsupported(name, deprecated, `scheme type "${String(raw.type)}" is not one oat knows`)
	}
}

/** Every scheme under `components.securitySchemes`, by name. */
export function readSchemes(doc: OpenApiDocument): ReadonlyMap<string, SecurityScheme> {
	const declared = doc.components?.securitySchemes ?? {}
	return new Map(Object.entries(declared).map(([name, value]) => [name, readScheme(name, value)]))
}
