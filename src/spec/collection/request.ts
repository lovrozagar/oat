/** The request body an operation takes: which media type oat sends, and its schema. */

import type { OperationObject, JsonSchema } from "../types.ts"
import { asSchema, effective } from "./effective.ts"

export interface RequestContent {
	mediaType: string
	schema: JsonSchema
	encoding?: Record<string, { contentType?: string }>
}

type Media = NonNullable<NonNullable<OperationObject["requestBody"]>["content"]>[string] | null

/* An object, or a reference oat cannot see into: either has properties of its own. */
function objectLike(schema: JsonSchema | null): boolean {
	return schema !== null && (schema.type === "object" || schema.properties !== undefined || schema.$ref !== undefined)
}

/**
 * Whether a urlencoded form can carry the body. Under the default `style: form, explode: true` an
 * object property spreads its keys among its siblings', and an array of objects has no form at all:
 * either one is lost unless its `encoding` writes it as JSON, or the object as a `deepObject`.
 */
function formCarries(media: Media): boolean {
	const properties = asSchema(effective(asSchema(media?.schema))?.properties) ?? {}
	return Object.entries(properties).every(([name, raw]) => {
		const encoding = media?.encoding?.[name] as { contentType?: string; style?: string } | undefined
		if (encoding?.contentType?.includes("json") === true) return true
		const property = effective(asSchema(raw))
		if (property?.type === "array") return !objectLike(effective(asSchema(property.items)))
		return !objectLike(property) || encoding?.style === "deepObject"
	})
}

function mediaRank(mediaType: string, media: Media, hasJson: boolean): number {
	if (mediaType.startsWith("multipart/")) return 0
	if (mediaType.includes("x-www-form-urlencoded")) return hasJson && !formCarries(media) ? 3 : 1
	if (mediaType.includes("json")) return 2
	return 4
}

/**
 * The request body oat sends: `preferred` when the operation documents it, else the best-ranked
 * one. Prefers multipart, then urlencoded, then JSON, then the first listed type: file ops often
 * document both JSON and a form, and the form is the real contract. A form that cannot carry the
 * body (`formCarries`) gives way to JSON documented beside it.
 */
export function requestContent(op: OperationObject, preferred?: string): RequestContent | null {
	const content = op.requestBody?.content
	if (content === undefined) return null
	const keys = Object.keys(content)
	if (keys.length === 0) return null

	const hasJson = keys.some((key) => key.includes("json"))
	const rank = (key: string): number => mediaRank(key, content[key] as Media, hasJson)
	/* `keys` is not empty, so a media type is always picked. */
	const mediaType =
		preferred !== undefined && keys.includes(preferred)
			? preferred
			: ([...keys].sort((a, b) => rank(a) - rank(b) || keys.indexOf(a) - keys.indexOf(b))[0] as string)
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

export function requestSchema(op: OperationObject): JsonSchema | null {
	const picked = requestContent(op)
	return picked === null ? null : picked.schema
}
