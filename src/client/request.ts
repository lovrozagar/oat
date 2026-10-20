/** One request, prepared once and sent per attempt: headers, fence, pacing and the wire. */

import { MissingValueError } from "../errors/missing-value.ts"
import type { Exchange } from "../runtime/exchange.ts"
import { headerValue } from "../runtime/headers.ts"
import type { RateLimiter } from "../runtime/rate-limit/limiter.ts"
import { credentialHeaderNames } from "../security/strip.ts"
import { answered, failed } from "./answer.ts"
import type { Pacing, Prepared, Sent, Timed, Wire } from "./attempt.ts"
import type { Actor } from "./credential-source.ts"
import { type FenceAsk, fenceAsker } from "./fence.ts"
import { requestIdOf, requestMessageBytes } from "./message.ts"
import { placedNames, placeOn, requestCredential, type Unplaced } from "./placing.ts"
import { sendFollowing } from "./redirect.ts"
import { addRequiredQuery, carriesMissingValue, encodeBody, requestUrl } from "./serialize.ts"
import type { NetworkClientOptions, RequestOptions, RequestStart } from "./types.ts"

/**
 * A request as the wire it is sent on will send it: its URL, operation, headers and credential. An
 * absolute URL on the client's own origin is resolved like a path; one on another origin matches no
 * operation, and a URL followed from a response carries no credential there.
 */
export function prepare(ctx: Wire, method: string, path: string, options: RequestOptions): Prepared {
	const verb = method.toUpperCase()
	const url = requestUrl(ctx.baseUrl, path, options.query)
	const foreign = url.origin !== new URL(ctx.baseUrl).origin
	const resolved = foreign ? null : (ctx.operationResolver?.(verb, ctx.relativePath(url)) ?? null)
	const callerQuery = new Set(url.searchParams.keys())
	addRequiredQuery(url, resolved?.requiredQuery ?? {}, options.query)
	const relative = ctx.relativePath(url)
	/* A value oat did not have, written as text: nothing goes out. */
	if (carriesMissingValue(url)) throw new MissingValueError(`${verb} ${relative}`)
	const operationId = options.operationId ?? resolved?.operationId
	const actor: Actor = foreign && "via" in options.as ? { anonymous: true } : options.as
	/* Never the query: a presigned URL's signature is a secret no message repeats. */
	const route = `${verb} ${foreign ? `${url.origin}${url.pathname}` : relative}`
	return {
		callerHeaders: () => {
			const raw = options.headers
			return { ...(typeof raw === "function" ? raw() : raw) }
		},
		callerQuery,
		credential: requestCredential(ctx, { actor, operationId, probe: options.probe, route }),
		method: verb,
		operationId,
		options,
		relative,
		resolved,
		url,
	}
}

/**
 * One attempt. Its credential is resolved first, so a request whose security cannot be met sends
 * nothing. A network failure is recorded as an exchange with status 0 and raised as a `NetworkError`.
 */
export async function sendAttempt(request: Prepared, attempt: number, wire: Wire): Promise<Exchange> {
	const { options } = request
	const placement = await request.credential.next()
	const { headers, url } = placeOn(placement, await unplaced(request, wire))
	const body = encodeBody(options.body, options.contentType)
	if (body.contentType !== undefined) headers["content-type"] = body.contentType
	/* The headers each hop sends: redirects strip and add to them, and the fence sees them as they are. */
	const hopHeaders = { ...headers }
	const fenced = { headers: hopHeaders, operationId: request.operationId, placement, purpose: options.context?.purpose }
	const fence = fenceAsker(wire.fence, fenced)
	await fence(url, request.method, options.body)
	const sent: Sent = { attempt, body, headers, placement, request, url }
	const pacing = pacingOf(request, wire.rateLimiter)
	await wire.slots.acquire()
	let landed: Timed
	try {
		const room = await paced(pacing, request.method, wire.rateLimiter)
		landed = await onTheWire(sent, { fence, hopHeaders, room }, wire)
	} finally {
		wire.slots.release()
	}
	return answered(landed, { ...sent, pacing }, wire)
}

/** The attempt before its credential: globals, then `resolveHeaders`, then the caller's headers. */
async function unplaced(request: Prepared, wire: Wire): Promise<Unplaced> {
	const { options } = request
	const hooked = await wire.resolveHeaders?.({
		method: request.method,
		url: request.url.toString(),
		...(options.operationId === undefined ? {} : { operationId: options.operationId }),
	})
	const layers = [wire.headers, hooked ?? {}, request.callerHeaders()]
	return { callerQuery: request.callerQuery, layers, url: request.url }
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
	fence: FenceAsk
	hopHeaders: Record<string, string>
	room: boolean | undefined
}

/** Sends the attempt and every redirect it follows, inside the hooks that watch the wire. */
async function onTheWire(sent: Sent, going: Going, wire: Wire): Promise<Timed> {
	const { request, headers, body, url } = sent
	const { options } = request
	const probe = probeOf(sent)
	const placed = placedNames(sent.placement)
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
				url,
			},
			{
				body: options.body,
				callerCookie: headerValue(headers, "cookie"),
				/* Every header that carries a credential: the known names, and whatever this request
				 * placed its credential under, an API key under a custom name included. */
				credentialNames: credentialHeaderNames(placed.headers),
				credentialQuery: placed.query,
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

function probeOf({ request, headers, body, url }: Sent): RequestStart {
	return {
		at: Date.now(),
		method: request.method,
		requestBytes: requestMessageBytes({ method: request.method, url }, headers, body),
		requestId: requestIdOf(headers, {}),
		url: url.toString(),
	}
}

function transport(network: NetworkClientOptions | undefined): (url: URL, init: RequestInit) => Promise<Response> {
	const timeoutMs = network?.requestTimeoutMs
	const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
	const send = network?.fetchImpl ?? fetch
	return (url, init) => send(url, signal === undefined ? init : { ...init, signal })
}
