/** Set-Cookie parsing, recorded response headers, and the Cookie header a request sends. */

import { headerValue } from "../headers.ts"

export function parseSetCookie(header: string): { name: string; value: string } | null {
	const cut = header.indexOf(";")
	const pair = cut === -1 ? header : header.slice(0, cut)
	const eq = pair.indexOf("=")
	if (eq <= 0) return null
	const name = pair.slice(0, eq).trim()
	if (name === "") return null
	let value = pair.slice(eq + 1).trim()
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		value = value.slice(1, -1)
	}
	return { name, value }
}

export function setCookieHeadersFrom(headers: Headers): string[] {
	if (typeof headers.getSetCookie === "function") {
		const listed = headers.getSetCookie()
		if (listed.length > 0) return listed
	}
	const combined = headers.get("set-cookie")
	if (combined === null || combined === "") return []
	return [combined]
}

export function recordResponseHeaders(headers: Headers): Record<string, string> {
	const out = Object.fromEntries(headers.entries())
	const setCookies = setCookieHeadersFrom(headers)
	if (setCookies.length > 0) out["set-cookie"] = setCookies.join("\n")
	return out
}

export function omitHeader(headers: Record<string, string>, name: string): void {
	const want = name.toLowerCase()
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === want) delete headers[key]
	}
}

export function cookiesFromRecordedHeaders(headers: Record<string, string>): Record<string, string> {
	const raw = headerValue(headers, "set-cookie")
	if (raw === undefined || raw === "") return {}
	const out: Record<string, string> = {}
	for (const line of raw.split("\n")) {
		const parsed = parseSetCookie(line)
		if (parsed === null || parsed.value === "") continue
		out[parsed.name] = parsed.value
	}
	return out
}

/** A non-empty value by exact name first, then by name in any case. */
function namedValue(cookies: Record<string, string>, name: string): string | undefined {
	const direct = cookies[name]
	if (direct !== undefined && direct !== "") return direct
	const want = name.toLowerCase()
	for (const [key, value] of Object.entries(cookies)) {
		if (key.toLowerCase() === want && value !== "") return value
	}
	return undefined
}

export function cookieValue(
	name: string,
	cookies: Record<string, string>,
	headers?: Record<string, string>,
): string | undefined {
	const held = namedValue(cookies, name)
	if (held !== undefined) return held
	if (headers === undefined) return undefined
	return namedValue(cookiesFromRecordedHeaders(headers), name)
}

export function mergeCookieHeader(existing: string | undefined, fromJar: string | undefined): string | undefined {
	if (fromJar === undefined || fromJar === "") return existing
	if (existing === undefined || existing === "") return fromJar
	return `${existing}; ${fromJar}`
}
