/** The request body an operation takes: which media type oat sends, and its schema. */

import type { OperationObject, SchemaObject } from "../types.ts"

export interface RequestContent {
	mediaType: string
	schema: SchemaObject
	encoding?: Record<string, { contentType?: string }>
}

function mediaRank(mediaType: string): number {
	if (mediaType.startsWith("multipart/")) return 0
	if (mediaType.includes("x-www-form-urlencoded")) return 1
	if (mediaType.includes("json")) return 2
	return 3
}

/**
 * The request body oat sends: `preferred` when the operation documents it, else the best-ranked
 * one. Prefers multipart, then urlencoded, then JSON, then the first listed type: file ops often
 * document both JSON and a form, and the form is the real contract.
 */
export function requestContent(op: OperationObject, preferred?: string): RequestContent | null {
	const content = op.requestBody?.content
	if (content === undefined) return null
	const keys = Object.keys(content)
	if (keys.length === 0) return null

	/* `keys` is not empty, so a media type is always picked. */
	const mediaType =
		preferred !== undefined && keys.includes(preferred)
			? preferred
			: ([...keys].sort((a, b) => mediaRank(a) - mediaRank(b) || keys.indexOf(a) - keys.indexOf(b))[0] as string)
	/* A media type written with no body (`application/json:` in YAML) is null. */
	const media = content[mediaType] as (typeof content)[string] | null
	const picked: RequestContent = { mediaType, schema: media?.schema ?? {} }
	if (media?.encoding !== undefined) picked.encoding = media.encoding
	return picked
}

export function hasRequestBody(op: OperationObject): boolean {
	const content = op.requestBody?.content
	return content !== undefined && Object.keys(content).length > 0
}

export function requestSchema(op: OperationObject): SchemaObject | null {
	const picked = requestContent(op)
	return picked === null ? null : picked.schema
}
