/**
 * Cookie jar, Set-Cookie parsing, and saveAs addressing for header / cookie values.
 *
 * Fetch follows redirects by default and drops intermediate Set-Cookie. Consume pages
 * commonly 303 with the session cookie on the redirect response — oat has to keep that
 * cookie if saveAs is going to bind it.
 */

export const MAX_REDIRECTS = 20

export function isAbsoluteHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value)
}

export function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

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

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
	const want = name.toLowerCase()
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === want) return value
	}
	return undefined
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

export function cookieValue(
	name: string,
	cookies: Record<string, string>,
	headers?: Record<string, string>,
): string | undefined {
	const direct = cookies[name]
	if (direct !== undefined && direct !== "") return direct
	const want = name.toLowerCase()
	for (const [key, value] of Object.entries(cookies)) {
		if (key.toLowerCase() === want && value !== "") return value
	}
	if (headers === undefined) return undefined
	const fromHeaders = cookiesFromRecordedHeaders(headers)
	const recorded = fromHeaders[name]
	if (recorded !== undefined && recorded !== "") return recorded
	for (const [key, value] of Object.entries(fromHeaders)) {
		if (key.toLowerCase() === want && value !== "") return value
	}
	return undefined
}

export function mergeCookieHeader(existing: string | undefined, fromJar: string | undefined): string | undefined {
	if (fromJar === undefined || fromJar === "") return existing
	if (existing === undefined || existing === "") return fromJar
	return `${existing}; ${fromJar}`
}

export interface RedirectTarget {
	url: URL
	method: string
	dropBody: boolean
}

export function redirectTarget(
	status: number,
	method: string,
	location: string | null,
	currentUrl: URL,
): RedirectTarget | null {
	if (!isRedirectStatus(status)) return null
	if (location === null || location === "") return null
	let next: URL
	try {
		next = new URL(location, currentUrl)
	} catch {
		return null
	}
	if (next.protocol !== "http:" && next.protocol !== "https:") return null
	const verb = method.toUpperCase()
	if (status === 307 || status === 308) {
		return { dropBody: false, method: verb, url: next }
	}
	if (status === 303 || ((status === 301 || status === 302) && verb !== "GET" && verb !== "HEAD")) {
		return { dropBody: true, method: "GET", url: next }
	}
	return { dropBody: false, method: verb, url: next }
}

export class CookieJar {
	private readonly cookies = new Map<string, { host: string; name: string; value: string }>()

	absorb(url: URL, setCookieHeaders: readonly string[]): void {
		const host = url.hostname
		for (const header of setCookieHeaders) {
			const parsed = parseSetCookie(header)
			if (parsed === null || parsed.value === "") continue
			this.cookies.set(`${host}\t${parsed.name}`, { host, name: parsed.name, value: parsed.value })
		}
	}

	cookieHeader(url: URL): string | undefined {
		const parts: string[] = []
		for (const cookie of this.cookies.values()) {
			if (cookie.host !== url.hostname) continue
			parts.push(`${cookie.name}=${cookie.value}`)
		}
		return parts.length === 0 ? undefined : parts.join("; ")
	}

	snapshot(): Record<string, string> {
		const out: Record<string, string> = {}
		for (const cookie of this.cookies.values()) {
			out[cookie.name] = cookie.value
		}
		return out
	}

	get size(): number {
		return this.cookies.size
	}
}

export type SaveAsKind =
	| { kind: "cookie"; name: string }
	| { kind: "header"; name: string }
	| { kind: "json"; path: string }

export function describeSaveAs(address: string): SaveAsKind {
	const colon = address.indexOf(":")
	const prefix = colon === -1 ? "" : address.slice(0, colon)
	const rest = colon === -1 ? address : address.slice(colon + 1).trim()
	if (prefix.toLowerCase() === "cookie") return { kind: "cookie", name: rest }
	if (prefix.toLowerCase() === "header") return { kind: "header", name: rest }
	return { kind: "json", path: address }
}

export function readSaveAs(
	address: string,
	source: {
		body: unknown
		headers: Record<string, string>
		cookies: Record<string, string>
		readJson: (body: unknown, path: string) => unknown
	},
): unknown {
	const described = describeSaveAs(address)
	if (described.kind === "cookie") {
		if (described.name === "") return undefined
		return cookieValue(described.name, source.cookies, source.headers)
	}
	if (described.kind === "header") {
		if (described.name === "" || described.name.toLowerCase() === "set-cookie") return undefined
		const value = headerValue(source.headers, described.name)
		return value === undefined || value === "" ? undefined : value
	}
	return source.readJson(source.body, described.path)
}

export interface RedirectHop {
	url: string
	status: number
	responseHeaders: Record<string, string>
}

export function applyJarToHeaders(headers: Record<string, string>, jar: CookieJar, url: URL): void {
	const fromJar = jar.cookieHeader(url)
	if (fromJar === undefined) return
	const existing = headerValue(headers, "cookie")
	omitHeader(headers, "cookie")
	headers.cookie = existing === undefined || existing === "" ? fromJar : `${existing}; ${fromJar}`
}
