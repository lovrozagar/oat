/** A specification's text read as an OpenAPI 3.x document, JSON or YAML. */

import { messageOf } from "../../errors/message.ts"
import type { OpenApiDocument } from "../types.ts"
import { assertVersion } from "./version.ts"

/** Parses `text` read from `source`; every failure names the source and what went wrong. */
export async function parseDocument(text: string, source: string): Promise<OpenApiDocument> {
	return assertOpenApi(await parseText(text, source), source)
}

/** Parses JSON or YAML text read from `source`, whatever it holds: a file another one refers to. */
export async function parseText(text: string, source: string): Promise<unknown> {
	/* A byte-order mark is not part of the document; JSON.parse rejects it outright. */
	const body = text.replace(/^\uFEFF/, "")
	if (body.trim() === "") {
		throw new Error(`oat: ${source} is empty`)
	}
	return looksLikeJson(body) ? parseJson(body, source) : parseYaml(body, source)
}

function parseJson(text: string, source: string): unknown {
	try {
		return JSON.parse(text)
	} catch (error) {
		throw new Error(`oat: ${source} starts as JSON but does not parse: ${messageOf(error)}. ${diagnoseJson(text)}`, {
			cause: error,
		})
	}
}

async function parseYaml(text: string, source: string): Promise<unknown> {
	try {
		const { parse } = await import("yaml")
		return parse(text)
	} catch (error) {
		throw new Error(`oat: could not parse ${source} as JSON or YAML: ${messageOf(error)}`, { cause: error })
	}
}

/**
 * Accepts an OpenAPI 3.0–3.2 document and nothing else; `assertVersion` refuses every other
 * version as the caller's to convert.
 *
 * YAML parses almost any text — a `Not Found` page is a valid YAML string — so "it parsed" says
 * nothing about whether this is a document oat can test. Accepting it produced a run that graded
 * zero operations and reported success.
 */
export function assertOpenApi(parsed: unknown, source: string): OpenApiDocument {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		const shown = typeof parsed === "string" ? JSON.stringify(parsed.slice(0, 60)) : String(parsed)
		throw new Error(`oat: ${source} is not an OpenAPI document — it parsed as ${shown}`)
	}
	const doc = parsed as Record<string, unknown>
	assertVersion(doc, source)
	if (doc.paths === null || typeof doc.paths !== "object" || Array.isArray(doc.paths)) {
		throw new Error(`oat: ${source} has no "paths" object, so there is nothing to test`)
	}
	return doc as OpenApiDocument
}

function looksLikeJson(text: string): boolean {
	const first = text.trimStart()[0]
	return first === "{" || first === "["
}

/**
 * Distinguishes a malformed document from a truncated one. A spec cut short by a proxy or a
 * download limit is by far the most common cause, and reporting it as invalid syntax sends
 * people looking for a bug in a file that is actually fine.
 */
function diagnoseJson(text: string): string {
	const opens = (text.match(/[[{]/g) as RegExpMatchArray).length
	const closes = (text.match(/[\]}]/g) ?? []).length
	if (opens > closes) {
		return (
			`The document has ${opens - closes} more opening than closing brackets, so it is most ` +
			`likely truncated — it ends after ${text.length} bytes. Check for a download or proxy ` +
			"size limit."
		)
	}
	return "The document appears complete, so this is a syntax error rather than truncation."
}
