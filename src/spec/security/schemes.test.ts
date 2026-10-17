import { describe, expect, it } from "vitest"
import { anyrow, everyScheme, immich, keycloak } from "./__fixtures__/documents.ts"
import { readSchemes, type SecurityScheme } from "./schemes.ts"

function oauth2(scheme: SecurityScheme | undefined): Extract<SecurityScheme, { kind: "oauth2" }> {
	if (scheme?.kind !== "oauth2") throw new Error(`expected an oauth2 scheme, got ${scheme?.kind}`)
	return scheme
}

describe("readSchemes", () => {
	const schemes = readSchemes(everyScheme)

	it("reads http bearer and basic, case-insensitively, with the bearer format and deprecation", () => {
		expect(schemes.get("bearer")).toEqual({ bearerFormat: "JWT", deprecated: true, kind: "bearer", name: "bearer" })
		expect(schemes.get("basic")).toEqual({ deprecated: false, kind: "basic", name: "basic" })
		expect(readSchemes(immich).get("bearer")?.kind).toBe("bearer")
	})

	it("reads an API key in a header, a query parameter or a cookie", () => {
		expect(schemes.get("header")).toEqual({
			deprecated: false,
			in: "header",
			kind: "apiKey",
			name: "header",
			param: "X-Key",
		})
		expect(schemes.get("query")).toMatchObject({ in: "query", kind: "apiKey", param: "api_key" })
		expect(schemes.get("cookie")).toMatchObject({ in: "cookie", kind: "apiKey", param: "session" })
	})

	it("reads every OAuth 2 flow, the 3.2 device flow and metadata URL included", () => {
		const oauth = oauth2(schemes.get("oauth"))
		expect(oauth.oauth2MetadataUrl).toBe("https://auth.test/.well-known/oauth-authorization-server")
		expect(Object.keys(oauth.flows).toSorted()).toEqual([
			"authorizationCode",
			"clientCredentials",
			"deviceAuthorization",
			"implicit",
			"password",
		])
		expect(oauth.flows.deviceAuthorization?.deviceAuthorizationUrl).toBe("https://auth.test/device")
		expect(oauth.flows.clientCredentials).toEqual({
			refreshUrl: "https://auth.test/refresh",
			scopes: ["read"],
			tokenUrl: "/token",
		})
		expect(schemes.get("oidc")).toMatchObject({
			kind: "openIdConnect",
			openIdConnectUrl: "https://auth.test/.well-known/openid-configuration",
		})
	})
})

describe("readSchemes, what oat cannot send", () => {
	const schemes = readSchemes(everyScheme)

	it("marks what oat cannot send as unsupported, saying why", () => {
		expect(schemes.get("mtls")).toMatchObject({
			kind: "unsupported",
			unsupported: expect.stringContaining("mutualTLS"),
		})
		expect(schemes.get("digest")).toMatchObject({ kind: "unsupported", unsupported: expect.stringContaining("digest") })
		expect(schemes.get("strange")).toMatchObject({
			kind: "unsupported",
			unsupported: expect.stringContaining("kerberos"),
		})
		expect(schemes.get("broken")).toMatchObject({ kind: "unsupported", unsupported: expect.stringContaining("name") })
	})

	it("reads the anyrow pair and nothing from a document that declares no scheme", () => {
		expect([...readSchemes(anyrow).keys()].toSorted()).toEqual(["apiKey", "jwt"])
		expect(readSchemes(keycloak).size).toBe(0)
	})

	it("treats a scheme that is not an object as unsupported", () => {
		const doc = { ...keycloak, components: { securitySchemes: { odd: "x" } } }
		expect(readSchemes(doc).get("odd")).toMatchObject({ kind: "unsupported" })
	})
})

describe("oauth2 helper", () => {
	it("refuses a scheme of another kind", () => {
		expect(() => oauth2(readSchemes(everyScheme).get("basic"))).toThrow("expected an oauth2 scheme")
	})
})

describe("readSchemes, at the edges", () => {
	const schemes = readSchemes({
		...keycloak,
		components: {
			securitySchemes: {
				bareFlow: { flows: { clientCredentials: null, password: { tokenUrl: 7 } }, type: "oauth2" },
				bareHttp: { type: "http" },
				body: { in: "body", name: "key", type: "apiKey" },
				negotiate: { scheme: "negotiate", type: "http" },
				noFlows: { type: "oauth2" },
				noUrl: { type: "openIdConnect" },
			},
		},
	})

	it("reads an oauth2 scheme with no flows, or flows that declare nothing", () => {
		expect(schemes.get("noFlows")).toEqual({ deprecated: false, flows: {}, kind: "oauth2", name: "noFlows" })
		expect(oauth2(schemes.get("bareFlow")).flows).toEqual({
			clientCredentials: { scopes: [] },
			password: { scopes: [] },
		})
	})

	it("marks an http scheme it cannot send, a misplaced key and an OpenID scheme without its URL unsupported", () => {
		const reasons = ["bareHttp", "negotiate", "body", "noUrl"].map((name) => schemes.get(name)?.kind)
		expect(reasons).toEqual(["unsupported", "unsupported", "unsupported", "unsupported"])
		expect(schemes.get("noUrl")).toMatchObject({ unsupported: expect.stringContaining("openIdConnectUrl") })
	})
})
