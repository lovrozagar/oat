/**
 * Where a redirect goes, and with which method and body.
 *
 * Fetch follows redirects by default and drops intermediate Set-Cookie. Consume pages
 * commonly 303 with the session cookie on the redirect response — oat follows hops itself so it
 * can keep that cookie if saveAs is going to bind it.
 */

export const MAX_REDIRECTS = 20

export function isAbsoluteHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value)
}

export function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

export interface RedirectTarget {
	url: URL
	method: string
	dropBody: boolean
}

export interface RedirectHop {
	url: string
	status: number
	responseHeaders: Record<string, string>
}

/** What a redirect answer says: its status and its `Location` header. */
export interface RedirectAnswer {
	status: number
	location: string | null
}

/** Where `request`'s redirect answer sends it next, or `null` when it sends it nowhere. */
export function redirectTarget(
	{ status, location }: RedirectAnswer,
	request: Pick<RedirectTarget, "method" | "url">,
): RedirectTarget | null {
	const { method, url: currentUrl } = request
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
