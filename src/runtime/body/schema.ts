/** What a request schema says about its parts: which are files, and what each file's type is. */

function isJsonMedia(mediaType: string): boolean {
	/* `split` always yields a first part. */
	const bare = (mediaType.split(";")[0] as string).trim().toLowerCase()
	return bare.includes("json")
}

function isBinarySchema(schema: Record<string, unknown>): boolean {
	const format = typeof schema.format === "string" ? schema.format.toLowerCase() : ""
	if (format === "binary" || format === "byte") return true
	const encoding = typeof schema.contentEncoding === "string" ? schema.contentEncoding.toLowerCase() : ""
	if (encoding === "binary" || encoding === "base64") return true
	const media = typeof schema.contentMediaType === "string" ? schema.contentMediaType : ""
	if (media !== "" && !isJsonMedia(media)) return true
	return false
}

export function isFilePart(schema: unknown, encoding?: { contentType?: string }): boolean {
	if (schema === null || typeof schema !== "object") return false
	const record = schema as Record<string, unknown>
	if (isBinarySchema(record)) return true
	const encoded = encoding?.contentType
	if (typeof encoded === "string" && encoded !== "" && !isJsonMedia(encoded)) return true
	const union = record.oneOf ?? record.anyOf
	if (Array.isArray(union)) return union.some((branch) => isFilePart(branch, encoding))
	return false
}

export function contentMediaTypeOf(
	schema: Record<string, unknown>,
	encoding?: { contentType?: string },
): string | undefined {
	if (typeof encoding?.contentType === "string" && encoding.contentType !== "") {
		/* `split` always yields a first part. */
		return (encoding.contentType.split(",")[0] as string).trim()
	}
	if (typeof schema.contentMediaType === "string" && schema.contentMediaType !== "") {
		return schema.contentMediaType
	}
	const format = typeof schema.format === "string" ? schema.format.toLowerCase() : ""
	if (format === "binary" || format === "byte") return "application/octet-stream"
	return undefined
}

export function propertiesOf(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return {}
	const out: Record<string, Record<string, unknown>> = {}
	for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
		if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) out[name] = raw as Record<string, unknown>
	}
	return out
}

export function requiredOf(schema: Record<string, unknown>): string[] {
	return Array.isArray(schema.required)
		? schema.required.filter((item): item is string => typeof item === "string")
		: []
}

export function additionalSchema(schema: Record<string, unknown>): Record<string, unknown> | undefined {
	const additional = schema.additionalProperties
	if (additional === null || typeof additional !== "object" || Array.isArray(additional)) return undefined
	return additional as Record<string, unknown>
}
