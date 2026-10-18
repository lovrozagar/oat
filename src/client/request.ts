/** One request, prepared once and sent per attempt: headers, fence, pacing and the wire. */

import { MissingValueError } from "../errors/missing-value.ts"
import { isAbsoluteHttpUrl } from "../runtime/cookies/redirect.ts"
import type { Exchange } from "../runtime/exchange.ts"
import { headerValue } from "../runtime/headers.ts"
import type { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import { credentialHeaderNames } from "../security/strip.ts"
import { answered, failed } from "./answer.ts"
import type { Pacing, Prepared, Sent, Timed, Wire } from "./attempt.ts"
import type { Credential } from "./credential-source.ts"
import { type FenceAsk, fenceAsker } from "./fence.ts"
import { requestIdOf, requestMessageBytes } from "./message.ts"
import { sendFollowing } from "./redirect.ts"
import { addRequiredQuery, carriesMissingValue, encodeBody, requestUrl } from "./serialize.ts"
import type { NetworkClientOptions, RequestOptions, RequestStart } from "./types.ts"

export function prepare(method: string, path: string, options: RequestOptions, wire: Wire): Prepared {
	const verb = method.toUpperCase()
	const url = requestUrl(wire.baseUrl, path, options.query)
	const resolved = isAbsoluteHttpUrl(path) ? null : (wire.operationResolver?.(verb, wire.relativePath(url)) ?? null)
	addRequiredQuery(url, resolved?.requiredQuery ?? {}, options.query)
	const relative = wire.relativePath(url)
	/* A value oat did not have, written as text: nothing goes out. */
	if (carriesMissingValue(url)) throw new MissingValueError(`${verb} ${relative}`)
	const operationId = options.operationId ?? resolved?.operationId
	const named = operationId === undefined ? {} : { operationId }
	const skip = options.skipAuthRefresh === true
	return {
		callerHeaders: () => {
			const raw = options.headers
			return { ...(typeof raw === "function" ? raw() : raw) }
		},
		credential: (headers) => (skip ? undefined : wire.credentials?.credentialFor({ headers, ...named })),
		method: verb,
		operationId,
		options,
		relative,
		resolved,
		url,
	}
}

/** One attempt. A network failure is recorded as an exchange with status 0 and raised as a `NetworkError`. */
export async function sendAttempt(request: Prepared, attempt: number, wire: Wire): Promise<Exchange> {
	const { options } = request
	const { headers, caller, credential } = await headersFor(request, wire)
	const body = encodeBody(options.body, options.contentType)
	if (body.contentType !== undefined) headers["content-type"] = body.contentType
	/* The headers each hop sends: redirects strip and add to them, and the fence sees them as they are. */
	const hopHeaders = { ...headers }
	const fenced = { headers: hopHeaders, operationId: request.operationId, purpose: options.context?.purpose }
	const fence = fenceAsker(wire.fence, fenced)
	await fence(request.url, request.method, options.body)
	const sent: Sent = { attempt, body, caller, headers, request }
	const pacing = pacingOf(request, wire.rateLimiter)
	await wire.slots.acquire()
	let landed: Timed
	try {
		const room = await paced(pacing, request.method, wire.rateLimiter)
		landed = await onTheWire(sent, { credential, fence, hopHeaders, room }, wire)
	} finally {
		wire.slots.release()
	}
	return answered(landed, { ...sent, pacing }, wire)
}

/** The headers one attempt sends: globals, then `resolveHeaders`, then the caller's, then the credential. */
async function headersFor(
	request: Prepared,
	wire: Wire,
): Promise<{ headers: Record<string, string>; caller: Record<string, string>; credential: Credential | undefined }> {
	const { options } = request
	const own = request.callerHeaders()
	const hooked = await wire.resolveHeaders?.({
		method: request.method,
		url: request.url.toString(),
		...(options.operationId === undefined ? {} : { operationId: options.operationId }),
	})
	const credential = request.credential(own)
	const caller = credential === undefined ? own : { ...own, ...credential.headers() }
	return { caller, credential, headers: { ...wire.headers, ...hooked, ...caller } }
}

/* Rules are written against documented paths, which never include the base path. */
function pacingOf(request: Prepared, limiter: RateLimiter | undefined): Pacing | undefined {
	const tagged = limiter?.resolve(request.method, request.relative, request.operationId)
	if (tagged !== undefined) return { rule: tagged, tagged: true }
	const implicit = limiter?.implicitRule(request.method)
	return implicit === undefined ? undefined : { rule: implicit, tagged: false }
}

/*
 * Two independent constraints, both held: maxInFlight bounds in-flight HTTP with no notion of
 * time, a rate-limit category bounds throughput over time. Pacing sits entirely inside the
 * in-flight slot and never changes what maxInFlight itself guarantees. The origin's ceiling holds
 * alongside the route's own budget; neither replaces the other.
 */
async function paced(
	pacing: Pacing | undefined,
	method: string,
	limiter: RateLimiter | undefined,
): Promise<boolean | undefined> {
	if (limiter === undefined) return undefined
	await limiter.acquireCeiling()
	if (pacing === undefined) return undefined
	return pacing.tagged ? limiter.acquire(pacing.rule) : limiter.waitImplicit(method)
}

interface Going {
	credential: Credential | undefined
	fence: FenceAsk
	hopHeaders: Record<string, string>
	room: boolean | undefined
}

/** Sends the attempt and every redirect it follows, inside the hooks that watch the wire. */
async function onTheWire(sent: Sent, going: Going, wire: Wire): Promise<Timed> {
	const { request, headers, body } = sent
	const { options } = request
	const probe = probeOf(sent)
	wire.httpHooks?.start?.(probe)
	const started = performance.now()
	try {
		const manual = options.redirect !== undefined || request.resolved?.redirects === true
		const following = await sendFollowing(
			{
				body: body.init,
				headers: going.hopHeaders,
				method: request.method,
				redirect: manual ? "manual" : undefined,
				url: request.url,
			},
			{
				body: options.body,
				callerCookie: headerValue(headers, "cookie"),
				/* Every header that carries a credential: the known names, and whatever the bound
				 * principal injects — an API key under a custom name is still a key. */
				credentialNames: credentialHeaderNames(Object.keys(going.credential?.headers() ?? {})),
				fence: going.fence,
				follow: options.redirect === "follow",
				send: transport(wire.network),
			},
		)
		return { ...following, at: Date.now(), room: going.room, started }
	} catch (error) {
		throw await failed(error, { ...sent, probe, started }, wire)
	} finally {
		wire.httpHooks?.end?.(probe)
	}
}

function probeOf({ request, headers, body }: Sent): RequestStart {
	return {
		at: Date.now(),
		method: request.method,
		requestBytes: requestMessageBytes(request.method, request.url, headers, body),
		requestId: requestIdOf(headers, {}),
		url: request.url.toString(),
	}
}

function transport(network: NetworkClientOptions | undefined): (url: URL, init: RequestInit) => Promise<Response> {
	const timeoutMs = network?.requestTimeoutMs
	const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
	const send = network?.fetchImpl ?? fetch
	return (url, init) => send(url, signal === undefined ? init : { ...init, signal })
}
