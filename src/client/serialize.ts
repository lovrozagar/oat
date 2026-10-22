/** A request as it goes on the wire: its URL with the query, and its body encoded for `fetch`. */

import { isAbsoluteHttpUrl } from "../runtime/cookies/redirect.ts"
import {
	bodyByteLength,
	formDataBytes,
	isFormData,
	isRawBytes,
	isURLSearchParams,
	utf8Bytes,
} from "../runtime/exchange.ts"
import type { ParamStyle } from "../spec/graph/parameters.ts"
import { serializeParam } from "./param-style.ts"
import type { RequestOptions } from "./types.ts"

type FetchBody = NonNullable<RequestInit["body"]>

export interface EncodedBody {
	init?: FetchBody
	/** Set this header. `undefined` means do not touch Content-Type. */
	contentType?: string
	text?: string
	bytes: number
}

/** A request's query: the caller's values, and each parameter's declared style by name. */
export interface QueryWriting {
	query?: RequestOptions["query"]
	styles?: Readonly<Record<string, ParamStyle>> | undefined
}

/* Whether the URL already carries `name`, as itself or as a deepObject's `name[key]`. */
function carries(url: URL, name: string): boolean {
	return [...url.searchParams.keys()].some((key) => key === name || key.startsWith(`${name}[`))
}

/* Whether one raw `name=value` pair, its name decoded as a query decodes it, is among `names`. */
function namedIn(pair: string, names: Readonly<Record<string, unknown>>): boolean {
	return [...new URLSearchParams(pair).keys()].some((name) => Object.hasOwn(names, name))
}

/* Appends each parameter's pairs, as its style writes them, already percent-encoded. */
function appendQuery(url: URL, values: Readonly<Record<string, unknown>>, styles: QueryWriting["styles"] = {}): void {
	const pairs = Object.entries(values).flatMap(([name, value]) =>
		serializeParam({ ...styles[name], in: "query", name }, value),
	)
	if (pairs.length === 0) return
	const added = pairs.map(([key, value]) => `${key}=${value}`).join("&")
	url.search = url.search === "" ? added : `${url.search.slice(1)}&${added}`
}

/**
 * `path` under `baseUrl` (or as given when absolute), with the caller's query written in each
 * parameter's declared style. A value the caller sets replaces one the path already carries.
 */
export function requestUrl(baseUrl: string, path: string, { query, styles }: QueryWriting = {}): URL {
	const url = new URL(isAbsoluteHttpUrl(path) ? path : `${baseUrl}${path}`)
	const values = Object.fromEntries(Object.entries(query ?? {}).filter(([, value]) => value !== undefined))
	/* Pair by pair, not through `searchParams`, which would rewrite the pairs it keeps as a form. */
	url.search = url.search
		.slice(1)
		.split("&")
		.filter((pair) => pair !== "" && !namedIn(pair, values))
		.join("&")
	appendQuery(url, values, styles)
	return url
}

/** The operation's required parameters the caller did not set. One the caller names — even as undefined — is theirs. */
export function addRequiredQuery(
	url: URL,
	required: Readonly<Record<string, unknown>>,
	{ query, styles }: QueryWriting = {},
): void {
	const missing = Object.entries(required).filter(([name]) => !(name in (query ?? {})) && !carries(url, name))
	appendQuery(url, Object.fromEntries(missing), styles)
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
