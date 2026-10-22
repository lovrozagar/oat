/**
 * The header and cookie values an operation's required parameters declare, as the bottom layer of
 * an attempt's headers. Any other layer that sends the name wins, whatever its case. A name the
 * credential is placed under is never sent as a parameter (ruling A4): the declared value is an
 * example, the credential is the operation's security. Only what a layer itself sends there still
 * collides with the credential, as before.
 */

import { headerValue } from "../runtime/headers.ts"
import { serializeParam } from "./param-style.ts"
import { type Placement, placedNames } from "./placing.ts"
import type { ResolvedOperation } from "./types.ts"

type Layer = Readonly<Record<string, string>>

function cookieNames(header: string | undefined): string[] {
	return (header ?? "").split(";").map((pair) => pair.replace(/=.*$/s, "").trim())
}

/* The declared header values no layer and no placement sends already. */
function declaredHeaders(resolved: ResolvedOperation, placement: Placement, layers: readonly Layer[]): Layer {
	const styles = resolved.paramStyles?.header ?? {}
	const taken = new Set(
		[...layers.flatMap((layer) => Object.keys(layer)), ...placedNames(placement).headers].map((name) =>
			name.toLowerCase(),
		),
	)
	const out: Record<string, string> = {}
	for (const [name, value] of Object.entries(resolved.requiredHeaders ?? {})) {
		if (!taken.has(name.toLowerCase())) out[name] = serializeParam({ ...styles[name], in: "header", name }, value)
	}
	return out
}

/* The declared cookie pairs no layer and no placement sends already, as `name=value`. */
function declaredCookies(resolved: ResolvedOperation, placement: Placement, layers: readonly Layer[]): string[] {
	const styles = resolved.paramStyles?.cookie ?? {}
	const taken = new Set([
		...layers.flatMap((layer) => cookieNames(headerValue(layer, "cookie"))),
		...Object.values(placement.sends).flatMap((sends) => Object.keys(sends.cookies)),
	])
	return Object.entries(resolved.requiredCookies ?? {})
		.filter(([name]) => !taken.has(name))
		.flatMap(([name, value]) => serializeParam({ ...styles[name], in: "cookie", name }, value))
		.map(([name, value]) => `${name}=${value}`)
}

/**
 * `layers` with the operation's declared header and cookie values under them. Declared cookies join
 * the Cookie header the topmost layer sends, or start one.
 */
export function withDeclared(
	resolved: ResolvedOperation | null,
	placement: Placement,
	layers: readonly Layer[],
): Layer[] {
	if (resolved === null) return [...layers]
	const headers: Record<string, string> = { ...declaredHeaders(resolved, placement, layers) }
	const cookies = declaredCookies(resolved, placement, layers)
	const out = [...layers]
	const top = out.findLastIndex((layer) => headerValue(layer, "cookie") !== undefined)
	if (cookies.length > 0 && top === -1) headers["cookie"] = cookies.join("; ")
	if (cookies.length > 0 && top !== -1) {
		const layer = out[top] as Layer
		const name = Object.keys(layer).find((key) => key.toLowerCase() === "cookie") as string
		out[top] = { ...layer, [name]: [layer[name], ...cookies].join("; ") }
	}
	return [headers, ...out]
}
