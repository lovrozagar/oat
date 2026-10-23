/** Which bodies are kept inline, and which media types are bytes rather than text. */

export const INLINE_BODY_LIMIT: number = 256 * 1024

export function primaryMediaType(mediaType: string, fallback: string): string {
	/* A part that names a type holds a "/", so it is never empty. */
	const named = mediaType
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.includes("/"))
	return named ?? fallback
}

export function isBinaryMediaType(mediaType: string): boolean {
	const type = primaryMediaType(mediaType, "").toLowerCase()
	if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/")) return true
	if (type === "application/octet-stream" || type === "application/pdf" || type === "application/zip") return true
	if (type === "application/vnd.ms-excel") return true
	if (type.includes("spreadsheet") || type.includes("officedocument") || type.includes("opendocument")) return true
	return false
}
