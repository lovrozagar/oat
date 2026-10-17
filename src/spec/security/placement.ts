import type { ApiKeyLocation, SecurityScheme } from "./schemes.ts"

/*
 * Where a scheme's credential goes on the request, and how it is written. `{credential}` in the
 * template is the value a recipe produced; a basic pair is base64-encoded first. A scheme oat
 * cannot send has no placement.
 */

export interface Placement {
	in: ApiKeyLocation
	/** The header, query parameter or cookie name. */
	name: string
	template: string
	/** How the credential is encoded before it fills the template. */
	encode?: "base64"
}

const AUTHORIZATION = "Authorization"

export function placementOf(scheme: SecurityScheme): Placement | null {
	switch (scheme.kind) {
		case "bearer":
		case "oauth2":
		case "openIdConnect":
			return { in: "header", name: AUTHORIZATION, template: "Bearer {credential}" }
		case "basic":
			return { encode: "base64", in: "header", name: AUTHORIZATION, template: "Basic {credential}" }
		case "apiKey":
			return { in: scheme.in, name: scheme.param, template: "{credential}" }
		default:
			return null
	}
}
