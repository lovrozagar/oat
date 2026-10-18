/** The exchange an attempt leaves: the backend's answer, or a network failure recorded as status 0. */

import { networkInterfaces } from "node:os"
import type { Exchange } from "../runtime/exchange.ts"
import { INLINE_BODY_LIMIT } from "../runtime/exchanges.ts"
import { recordResponseHeaders } from "../runtime/cookies.ts"
import {
	classifyNetworkError,
	describeNetworkKind,
	hasUsableInterface,
	NetworkError,
	type NetworkKind,
	refineNetworkKind,
} from "../runtime/network.ts"
import { sha256Hex } from "../runtime/transcript.ts"
import type { Pacing, Sent, Timed, Wire } from "./attempt.ts"
import { requestIdOf, requestMessageBytes, responseMessageBytes } from "./message.ts"
import type { EncodedBody } from "./serialize.ts"
import type { NetworkClientOptions, RequestStart } from "./types.ts"

/** The error to raise for a failed send: a recorded `NetworkError`, or the error itself when it is not the network's. */
export async function failed(
	error: unknown,
	sent: Sent & { probe: RequestStart; started: number },
	wire: Wire,
): Promise<unknown> {
	const kind = networkKindOf(error, wire.network?.interfaces)
	if (kind === null) return error
	const { request, probe } = sent
	const url = request.url.toString()
	const message = `${request.method} ${url} failed (${kind}: ${describeNetworkKind(kind)})`
	const exchange: Exchange = {
		at: Date.now(),
		durationMs: Math.round(performance.now() - sent.started),
		method: request.method,
		network: { attempt: sent.attempt, kind, message },
		requestBody: request.options.body,
		requestBytes: probe.requestBytes,
		requestHeaders: sent.headers,
		requestId: probe.requestId,
		responseBody: { error: "network", kind, message },
		responseBytes: 0,
		responseHeaders: {},
		seq: wire.nextSeq(),
		status: 0,
		url,
		...stamped(sent, wire),
	}
	await wire.deliver(exchange, request.resolved?.entity ?? undefined)
	return new NetworkError({ attempts: sent.attempt + 1, cause: error, kind, message, method: request.method, url })
}

/* What failed, refined to offline when this machine has no usable interface; `null` when it was not the network. */
function networkKindOf(error: unknown, interfaces: NetworkClientOptions["interfaces"]): NetworkKind | null {
	const read = interfaces ?? networkInterfaces
	const raw = classifyNetworkError(error)
	if (raw !== null) return refineNetworkKind(raw, read)
	return hasUsableInterface(read) ? null : "offline"
}

/** The backend's answer, recorded and frozen: what the backend said is evidence no check may rewrite. */
export async function answered(
	landed: Timed,
	sent: Sent & { pacing: Pacing | undefined },
	wire: Wire,
): Promise<Exchange> {
	const { request, headers, body } = sent
	const { response, bodyBytes, digest } = landed
	const responseHeaders = recordResponseHeaders(response.headers)
	const exchange: Exchange = {
		at: landed.at,
		durationMs: Math.round(performance.now() - landed.started),
		method: request.method,
		requestBody: request.options.body,
		requestBytes: requestMessageBytes(request.method, request.url, headers, body),
		requestHeaders: headers,
		requestId: requestIdOf(headers, responseHeaders),
		responseBody: landed.parsed,
		responseBytes: responseMessageBytes(response, responseHeaders, bodyBytes),
		responseHeaders,
		...(digest === undefined ? {} : { responseDigest: digest }),
		...requestDigestOf(body),
		seq: wire.nextSeq(),
		status: response.status,
		url: request.url.toString(),
		...paced(sent.pacing, landed.room),
		...stamped(sent, wire),
		...travelled(landed, request.url),
	}
	await wire.deliver(exchange, request.resolved?.entity ?? undefined)
	return Object.freeze(exchange)
}

/* A body that will be stored by reference is hashed once, from the text that was sent. */
function requestDigestOf(body: EncodedBody): Pick<Exchange, "requestDigest"> {
	if (body.text === undefined || body.bytes <= INLINE_BODY_LIMIT) return {}
	return { requestDigest: { bytes: body.bytes, sha256: sha256Hex(Buffer.from(body.text)) } }
}

function paced(pacing: Pacing | undefined, room: boolean | undefined): Partial<Exchange> {
	return {
		...(pacing === undefined ? {} : { rateLimitCategory: pacing.rule.category, rateLimitSource: pacing.rule.source }),
		...(room === undefined ? {} : { rateLimitHadRoom: room }),
	}
}

/* The redirects it followed, where it landed when that is elsewhere, and the cookies it was handed. */
function travelled(landed: Timed, url: URL): Partial<Exchange> {
	const cookies = landed.jar.snapshot()
	const landing = landed.landing.toString()
	return {
		...(landed.hops.length === 0 ? {} : { redirects: landed.hops }),
		...(landing === url.toString() ? {} : { finalUrl: landing }),
		...(Object.keys(cookies).length === 0 ? {} : { cookies }),
	}
}

/** Who sent it, for what, and which documented operation it is. */
function stamped({ request, caller }: Sent, wire: Wire): Partial<Exchange> {
	const { resolved, operationId, options } = request
	const principal = wire.credentials?.principalOf(caller)
	const context = options.context ?? {}
	return {
		...(operationId === undefined ? {} : { operationId }),
		...(resolved === null ? {} : { template: resolved.template }),
		...(resolved?.pathParams === undefined ? {} : { pathParams: resolved.pathParams }),
		...(principal === undefined ? {} : { principal }),
		...(context.purpose === undefined ? {} : { purpose: context.purpose }),
		...(context.check === undefined ? {} : { check: context.check }),
		...(context.subject === undefined ? {} : { subject: context.subject }),
		...(options.fixture === undefined ? {} : { fixture: options.fixture }),
	}
}
