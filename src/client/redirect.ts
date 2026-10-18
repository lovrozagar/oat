/** One attempt on the wire, following redirects itself when asked so every hop's cookies are kept. */

import { applyJarToHeaders, CookieJar } from "../runtime/cookies/jar.ts"
import { isRedirectStatus, MAX_REDIRECTS, type RedirectHop, redirectTarget } from "../runtime/cookies/redirect.ts"
import { omitHeader, recordResponseHeaders, setCookieHeadersFrom } from "../runtime/cookies/set-cookie.ts"
import { readResponsePayload } from "../runtime/transcript/payload.ts"
import type { ResponsePayload } from "../runtime/transcript/types.ts"
import { stripCredentials } from "../security/strip.ts"
import type { FenceAsk } from "./fence.ts"

export interface FirstHop {
	url: URL
	method: string
	body: RequestInit["body"]
	/** Sent on every hop, and changed in place as hops strip and add to it. */
	headers: Record<string, string>
	/** `manual` when the caller or the operation handles redirects itself. */
	redirect: "manual" | undefined
}

export interface Following {
	/** Follow redirects here, through a cookie jar. Otherwise the first answer stands. */
	follow: boolean
	send: (url: URL, init: RequestInit) => Promise<Response>
	fence: FenceAsk
	/** The caller's own Cookie header, kept on same-origin hops alongside the jar's. */
	callerCookie: string | undefined
	/** Headers that carry a credential: stripped before a hop to another origin. */
	credentialNames: Parameters<typeof stripCredentials>[1]
	/** What the caller asked to send, for the fence; a hop that drops the body sends none. */
	body: unknown
}

export interface Landed extends ResponsePayload {
	response: Response
	hops: RedirectHop[]
	landing: URL
	jar: CookieJar
}

interface Hop {
	url: URL
	method: string
	body: RequestInit["body"]
}

export async function sendFollowing(first: FirstHop, how: Following): Promise<Landed> {
	const jar = new CookieJar()
	const hops: RedirectHop[] = []
	let current: Hop = { body: first.body, method: first.method, url: first.url }
	applyJarToHeaders(first.headers, jar, first.url, how.callerCookie)
	const init: RequestInit = { headers: first.headers, method: first.method }
	if (first.body !== undefined) init.body = first.body
	if (first.redirect !== undefined) init.redirect = first.redirect
	let answer = await sendHop(jar, current.url, init, how)
	while (how.follow && isRedirectStatus(answer.response.status) && hops.length < MAX_REDIRECTS) {
		const { response } = answer
		const next = redirectTarget(response.status, current.method, response.headers.get("location"), current.url)
		if (next === null) break
		hops.push({
			responseHeaders: recordResponseHeaders(response.headers),
			status: response.status,
			url: `${current.url}`,
		})
		current = { body: next.dropBody ? undefined : current.body, method: next.method, url: next.url }
		const crossOrigin = next.url.origin !== first.url.origin
		prepareHop(first.headers, { crossOrigin, dropBody: next.dropBody, jar, url: current.url }, how)
		await how.fence(current.url, current.method.toUpperCase(), next.dropBody ? undefined : how.body)
		answer = await sendHop(jar, current.url, hopInit(first.headers, current), how)
	}
	return { ...answer, hops, jar, landing: current.url }
}

/* Another origin — scheme, host or port — gets no credential of ours, and only the jar's cookies. */
function prepareHop(
	headers: Record<string, string>,
	hop: { crossOrigin: boolean; dropBody: boolean; jar: CookieJar; url: URL },
	how: Following,
): void {
	if (hop.crossOrigin) stripCredentials(headers, how.credentialNames)
	if (hop.dropBody) {
		omitHeader(headers, "content-type")
		omitHeader(headers, "content-length")
	}
	applyJarToHeaders(headers, hop.jar, hop.url, hop.crossOrigin ? undefined : how.callerCookie)
}

function hopInit(headers: Record<string, string>, hop: Hop): RequestInit {
	const init: RequestInit = { headers, method: hop.method, redirect: "manual" }
	if (hop.body !== undefined) init.body = hop.body
	return init
}

async function sendHop(
	jar: CookieJar,
	url: URL,
	init: RequestInit,
	how: Following,
): Promise<ResponsePayload & { response: Response }> {
	const response = await how.send(url, init)
	const payload = await readResponsePayload(response)
	jar.absorb(url, setCookieHeadersFrom(response.headers))
	return { ...payload, response }
}
