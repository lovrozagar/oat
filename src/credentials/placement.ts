import type { Recipe } from "../config/types/security.ts"
import { type Placement, placementOf } from "../spec/security/placement.ts"
import type { SecurityScheme } from "../spec/security/schemes.ts"
import type { Sends } from "./ports.ts"

/*
 * A credential value made into what a request sends. The scheme says where it goes; the recipe's
 * `format` rewrites only the template, and its `placements` add more places. A basic scheme's
 * `user:pass` is base64-encoded first, and `{credential}` everywhere means that encoded form. The
 * pair, its encoding and the bare password are all secrets, so a login body cannot leak the password.
 */

/** The names and values a redactor must scrub, so no report, journal or repro shows them. */
export interface Secrets {
	headers: string[]
	query: string[]
	cookies: string[]
	values: string[]
}

/** A scheme the document declares that oat has no way to send. */
export class UnsupportedSchemeError extends Error {
	override name = "UnsupportedSchemeError"
	constructor(
		readonly scheme: string,
		readonly reason: string,
	) {
		super(`oat cannot send the "${scheme}" scheme: ${reason}`)
	}
}

const PLACE_KEY = { cookie: "cookies", header: "headers", query: "query" } as const

/** The sends and the secrets for one value of one scheme, under the recipe's placement options. */
export function sendsFor(
	scheme: SecurityScheme,
	recipe: Pick<Partial<Recipe>, "format" | "placements">,
	value: string,
): { sends: Sends; secrets: Secrets } {
	const placement = placementOf(scheme)
	/* placementOf is null for exactly the unsupported kind. */
	if (placement === null) {
		throw new UnsupportedSchemeError(scheme.name, (scheme as { unsupported: string }).unsupported)
	}
	const credential = placement.encode === "base64" ? Buffer.from(value).toString("base64") : value
	const places: Placement[] = [
		{ ...placement, template: recipe.format ?? placement.template },
		...(recipe.placements ?? []).map((extra) => ({ ...extra, template: extra.template ?? "{credential}" })),
	]
	const sends: Sends = { cookies: {}, headers: {}, query: {} }
	const secrets: Secrets = { cookies: [], headers: [], query: [], values: secretValues(placement, value, credential) }
	for (const place of places) {
		const key = PLACE_KEY[place.in]
		sends[key][place.name] = place.template.replaceAll("{credential}", credential)
		secrets[key].push(place.name)
	}
	return { secrets, sends }
}

/* The value, its encoding, and for a basic pair the bare password after the first colon; never empty text. */
function secretValues(placement: Placement, value: string, credential: string): string[] {
	const colon = value.indexOf(":")
	const password = placement.encode === "base64" && colon !== -1 ? [value.slice(colon + 1)] : []
	return [...new Set([value, credential, ...password])].filter((secret) => secret !== "")
}
