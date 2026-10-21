/** saveAs addressing: a value bound from a cookie, a header, or a JSON path of the body. */

import { primaryMediaType } from "../exchanges/media.ts"
import { headerValue } from "../headers.ts"
import { cookieValue } from "./set-cookie.ts"

export type SaveAsKind =
	| { kind: "cookie"; name: string }
	| { kind: "header"; name: string }
	| { kind: "json"; path: string }

export interface SaveAsSource {
	body: unknown
	headers: Record<string, string>
	cookies: Record<string, string>
	readJson: (body: unknown, path: string) => unknown
}

export function describeSaveAs(address: string): SaveAsKind {
	const colon = address.indexOf(":")
	const prefix = colon === -1 ? "" : address.slice(0, colon)
	const rest = colon === -1 ? address : address.slice(colon + 1).trim()
	if (prefix.toLowerCase() === "cookie") return { kind: "cookie", name: rest }
	if (prefix.toLowerCase() === "header") return { kind: "header", name: rest }
	return { kind: "json", path: address }
}

export function readSaveAs(address: string, source: SaveAsSource): unknown {
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

/* The one media type an answer is read as a form for; JSON is the default, and nothing is sniffed. */
const FORM = "application/x-www-form-urlencoded"

/* An answer's media type, lowercased and without its parameters; "" when it names none. */
function mediaTypeOf(headers: Readonly<Record<string, string>>): string {
	return primaryMediaType(headerValue(headers, "content-type") ?? "", "").toLowerCase()
}

/**
 * The body an answer's credentials are read from: a form answer's top-level fields by name, else the
 * body as it was parsed. A form with no text, or text that also parsed as JSON, has no fields.
 */
export function answerBody(answer: { body: unknown; headers: Readonly<Record<string, string>> }): unknown {
	if (mediaTypeOf(answer.headers) !== FORM) return answer.body
	return typeof answer.body === "string" ? Object.fromEntries(new URLSearchParams(answer.body)) : {}
}

/** An answer's media type, for a reason that says why nothing could be read from it. */
export function describeAnswerType(headers: Readonly<Record<string, string>>): string {
	const type = mediaTypeOf(headers)
	return type === "" ? "its answer names no content type" : `its answer is ${type}`
}
