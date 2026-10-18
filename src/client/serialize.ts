/** A request as it goes on the wire: its URL with the query, and its body encoded for `fetch`. */

import { isAbsoluteHttpUrl } from "../runtime/cookies.ts"
import {
	bodyByteLength,
	formDataBytes,
	isFormData,
	isRawBytes,
	isURLSearchParams,
	utf8Bytes,
} from "../runtime/exchange.ts"
import type { RequestOptions } from "./types.ts"

type FetchBody = NonNullable<RequestInit["body"]>

export interface EncodedBody {
	init?: FetchBody
	/** Set this header. `undefined` means do not touch Content-Type. */
	contentType?: string
	text?: string
	bytes: number
}

/** `path` under `baseUrl` (or as given when absolute), with the caller's query. */
export function requestUrl(baseUrl: string, path: string, query: RequestOptions["query"]): URL {
	const url = new URL(isAbsoluteHttpUrl(path) ? path : `${baseUrl}${path}`)
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value === undefined) continue
		if (typeof value === "object") for (const item of value) url.searchParams.append(key, String(item))
		else url.searchParams.set(key, String(value))
	}
	return url
}

/** The operation's required parameters the caller did not set. One the caller names — even as undefined — is theirs. */
export function addRequiredQuery(
	url: URL,
	required: Readonly<Record<string, string>>,
	query: RequestOptions["query"],
): void {
	for (const [name, value] of Object.entries(required)) {
		if (!(name in (query ?? {})) && !url.searchParams.has(name)) url.searchParams.set(name, value)
	}
}

/* A path segment or query value that is the text of a missing value, never something oat chose. */
export function carriesMissingValue(url: URL): boolean {
	return (
		url.pathname.split("/").some((segment) => decoded(segment) === "undefined") ||
		[...url.searchParams.values()].includes("undefined")
	)
}

function decoded(segment: string): string {
	try {
		return decodeURIComponent(segment)
	} catch {
		return segment
	}
}

export function encodeBody(body: unknown, contentType: string | null | undefined): EncodedBody {
	if (body === undefined) return { bytes: 0 }
	if (contentType === null) return asIs(body)
	/* fetch sets multipart/form-data; boundary=… — setting it ourselves drops the boundary. */
	if (isFormData(body)) return { bytes: formDataBytes(body), init: body }
	if (isURLSearchParams(body)) {
		const text = body.toString()
		const type = contentType ?? "application/x-www-form-urlencoded"
		return { bytes: utf8Bytes(text), contentType: type, init: body, text }
	}
	if (isRawBytes(body) || typeof body === "string") {
		const encoded = asIs(body)
		if (contentType !== undefined) encoded.contentType = contentType
		return encoded
	}
	const text = JSON.stringify(body)
	return { bytes: utf8Bytes(text), contentType: contentType ?? "application/json", init: text, text }
}

/* Sent as it is, without touching Content-Type; anything fetch cannot send is sent as JSON. */
function asIs(body: unknown): EncodedBody {
	const encoded: EncodedBody = { bytes: bodyByteLength(body), init: asBodyInit(body) ?? JSON.stringify(body) }
	if (typeof body === "string") encoded.text = body
	return encoded
}

function asBodyInit(body: unknown): FetchBody | undefined {
	if (typeof body === "string") return body
	if (isFormData(body) || isURLSearchParams(body) || isRawBytes(body)) return body as FetchBody
	if (body instanceof ReadableStream) return body as FetchBody
	return undefined
}
