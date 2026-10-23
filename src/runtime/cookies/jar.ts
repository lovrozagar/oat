/** The cookie jar a redirect chain carries from hop to hop. */

import { mergeCookieHeader, omitHeader, parseSetCookie } from "./set-cookie.ts"

interface StoredCookie {
	name: string
	value: string
	/** The host it was set by, or the `Domain` it was widened to. */
	domain: string
	/** Set without `Domain`: sent back to exactly that host, never its subdomains. */
	hostOnly: boolean
	path: string
	secure: boolean
}

/** What one Set-Cookie header asks of the jar: store a cookie under `key`, or forget it. */
interface CookieChange {
	key: string
	cookie: StoredCookie | null
}

/** The directory of a request path — RFC 6265's default cookie path. */
function defaultPath(url: URL): string {
	const path = url.pathname
	if (!path.startsWith("/") || path.lastIndexOf("/") === 0) return "/"
	return path.slice(0, path.lastIndexOf("/"))
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
	if (requestPath === cookiePath) return true
	if (!requestPath.startsWith(cookiePath)) return false
	return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/"
}

function domainMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`)
}

/** The attributes after the name=value pair, keyed by lower-cased name. */
function attributesOf(header: string): Map<string, string> {
	const attributes = new Map<string, string>()
	for (const raw of header.split(";").slice(1)) {
		const eq = raw.indexOf("=")
		const key = (eq === -1 ? raw : raw.slice(0, eq)).trim().toLowerCase()
		attributes.set(key, eq === -1 ? "" : raw.slice(eq + 1).trim())
	}
	return attributes
}

/** The server deletes a cookie with an empty value, `Max-Age=0`, or an `Expires` in the past. */
function isDeletion(value: string, attributes: Map<string, string>): boolean {
	const maxAge = attributes.get("max-age")
	const expires = attributes.get("expires")
	return (
		value === "" ||
		(maxAge !== undefined && Number(maxAge) <= 0) ||
		(maxAge === undefined && expires !== undefined && Date.parse(expires) <= Date.now())
	)
}

/** The change one Set-Cookie header makes, or `null` when the jar ignores it. */
function changeFrom(header: string, url: URL, host: string): CookieChange | null {
	const parsed = parseSetCookie(header)
	if (parsed === null) return null
	const attributes = attributesOf(header)
	const declared = attributes.get("domain")?.replace(/^\./, "").toLowerCase()
	const hostOnly = declared === undefined || declared === ""
	/* A Domain the setting host does not belong to is refused, as a browser would. */
	if (!hostOnly && !domainMatches(host, declared)) return null
	const domain = hostOnly ? host : declared
	const declaredPath = attributes.get("path")
	const path = declaredPath?.startsWith("/") === true ? declaredPath : defaultPath(url)
	const key = `${domain}\t${path}\t${parsed.name}`
	if (isDeletion(parsed.value, attributes)) return { cookie: null, key }
	const secure = attributes.has("secure")
	return { cookie: { domain, hostOnly, name: parsed.name, path, secure, value: parsed.value }, key }
}

/**
 * A cookie jar that behaves like a browser's, as far as oat's flows can tell: a cookie goes back
 * only to the host (or `Domain`) and `Path` that set it, only over https when `Secure`, and is
 * forgotten when the server deletes it — an empty value, `Max-Age=0`, or an `Expires` in the past.
 */
export class CookieJar {
	private readonly cookies = new Map<string, StoredCookie>()

	absorb(url: URL, setCookieHeaders: readonly string[]): void {
		const host = url.hostname.toLowerCase()
		for (const header of setCookieHeaders) {
			const change = changeFrom(header, url, host)
			if (change === null) continue
			if (change.cookie === null) this.cookies.delete(change.key)
			else this.cookies.set(change.key, change.cookie)
		}
	}

	/** The cookies this jar would send to `url`, longest path first. */
	private matching(url: URL): StoredCookie[] {
		const host = url.hostname.toLowerCase()
		return [...this.cookies.values()]
			.filter(
				(cookie) =>
					(cookie.hostOnly ? cookie.domain === host : domainMatches(host, cookie.domain)) &&
					pathMatches(url.pathname || "/", cookie.path) &&
					(!cookie.secure || url.protocol === "https:"),
			)
			.sort((a, b) => b.path.length - a.path.length)
	}

	cookieHeader(url: URL): string | undefined {
		const parts = this.matching(url).map((cookie) => `${cookie.name}=${cookie.value}`)
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

/** Where a hop's cookies come from: the jar, for the hop's URL, and the caller's own Cookie header. */
export interface HopCookies {
	jar: CookieJar
	url: URL
	callerCookie?: string | undefined
}

/**
 * Rebuilds the Cookie header for one hop: the caller's own cookie, then whatever the jar holds
 * for this URL. Rebuilt rather than appended to, or every hop would repeat the last one's.
 */
export function applyJarToHeaders(headers: Record<string, string>, { jar, url, callerCookie }: HopCookies): void {
	const fromJar = jar.cookieHeader(url)
	omitHeader(headers, "cookie")
	const merged = mergeCookieHeader(callerCookie, fromJar)
	if (merged !== undefined && merged !== "") headers["cookie"] = merged
}
