import { describe, expect, it } from "vitest"
import { everyScheme } from "./__fixtures__/documents.ts"
import { placementOf } from "./placement.ts"
import { readSchemes } from "./schemes.ts"

const schemes = readSchemes(everyScheme)
const placed = (name: string) => {
	const scheme = schemes.get(name)
	if (scheme === undefined) throw new Error(`no scheme ${name}`)
	return placementOf(scheme)
}

describe("placementOf", () => {
	it("puts a bearer token, an OAuth 2 token and an OpenID token in Authorization", () => {
		const bearer = { in: "header", name: "Authorization", template: "Bearer {credential}" }
		expect([placed("bearer"), placed("oauth"), placed("oidc")]).toEqual([bearer, bearer, bearer])
	})

	it("puts a basic pair in Authorization, encoded by whoever fills the template", () => {
		expect(placed("basic")).toEqual({
			encode: "base64",
			in: "header",
			name: "Authorization",
			template: "Basic {credential}",
		})
	})

	it("puts an API key where its scheme says, bare", () => {
		expect(placed("header")).toEqual({ in: "header", name: "X-Key", template: "{credential}" })
		expect(placed("query")).toEqual({ in: "query", name: "api_key", template: "{credential}" })
		expect(placed("cookie")).toEqual({ in: "cookie", name: "session", template: "{credential}" })
	})

	it("has no placement for a scheme oat cannot send", () => {
		expect([placed("mtls"), placed("digest"), placed("strange")]).toEqual([null, null, null])
	})
})
