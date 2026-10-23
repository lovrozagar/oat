/** What an exchange weighed on the wire, and the request id either side named. */

import { utf8Bytes } from "../runtime/exchange.ts"

/** What a request's start line names: its method, and the URL it goes to. */
export interface RequestLine {
	method: string
	url: URL
}

/** Start line + headers + body. Host and Content-Length are filled when they would be on the wire. */
export function requestMessageBytes(
	{ method, url }: RequestLine,
	headers: Record<string, string>,
	body: { bytes: number; text?: string | undefined },
): number {
	const sent = { ...headers }
	if (!hasHeader(sent, "host")) sent["host"] = url.host
	if (body.bytes > 0 && !hasHeader(sent, "content-length")) sent["content-length"] = String(body.bytes)
	const start = `${method} ${url.pathname}${url.search} HTTP/1.1`
	if (body.text !== undefined) return headBytes(start, sent) + utf8Bytes(body.text)
	return headBytes(start, sent) + body.bytes
}

export function responseMessageBytes(response: Response, headers: Record<string, string>, bodyBytes: number): number {
	const sent = { ...headers }
	if (bodyBytes > 0 && !hasHeader(sent, "content-length")) sent["content-length"] = String(bodyBytes)
	const { status, statusText } = response
	const start = statusText === "" ? `HTTP/1.1 ${status}` : `HTTP/1.1 ${status} ${statusText}`
	return headBytes(start, sent) + bodyBytes
}

function headBytes(startLine: string, headers: Record<string, string>): number {
	let text = `${startLine}\r\n`
	for (const [key, value] of Object.entries(headers)) text += `${key}: ${value}\r\n`
	return utf8Bytes(`${text}\r\n`)
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const want = name.toLowerCase()
	return Object.keys(headers).some((key) => key.toLowerCase() === want)
}

const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-correlation-id", "correlation-id"] as const

/** Response header first, then the request. Empty when neither side sent one of the known names. */
export function requestIdOf(requestHeaders: Record<string, string>, responseHeaders: Record<string, string>): string {
	return headerOf(responseHeaders, REQUEST_ID_HEADERS) ?? headerOf(requestHeaders, REQUEST_ID_HEADERS) ?? ""
}

function headerOf(headers: Record<string, string>, names: readonly string[]): string | undefined {
	for (const name of names) {
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === name && value.trim() !== "") return value.trim()
		}
	}
	return undefined
}
