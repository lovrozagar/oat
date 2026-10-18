/** A path read segment by segment, with its parameters told apart from its literals. */

const PARAM_SEGMENT = /^\{[^}]+\}$/

/** Whether `segment` is a whole `{param}`. */
export function isParamSegment(segment: string): boolean {
	return PARAM_SEGMENT.test(segment)
}

/** The non-empty segments of `path`. */
export function segmentsOf(path: string): string[] {
	return path.split("/").filter(Boolean)
}

/** Segments with every parameter written `{}`, so templates that differ only in names compare equal. */
export function templateKey(segments: readonly string[]): string {
	return segments.map((s) => (isParamSegment(s) ? "{}" : s)).join("/")
}

/** `path` as a template key. */
export function pathShape(path: string): string {
	return templateKey(segmentsOf(path))
}
