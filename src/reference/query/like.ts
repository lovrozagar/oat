import type { LikeSegment } from "../query-types.ts"

/** A `like` value as segments: text, and the wildcards it holds. */
export function likePattern(raw: string, unescaped: boolean): LikeSegment[] {
	const segments: LikeSegment[] = []
	let text = ""
	const flush = (): void => {
		if (text !== "") segments.push({ kind: "text", text })
		text = ""
	}
	for (const ch of raw) {
		/* `*` is the grammar's wildcard. `%` and `_` are literals — unless the backend interpolates
		 * the value into a LIKE pattern without escaping it, which is the LIKE_UNESCAPED defect. */
		if (ch === "*" || (unescaped && ch === "%")) {
			flush()
			segments.push({ kind: "any" })
		} else if (unescaped && ch === "_") {
			flush()
			segments.push({ kind: "one" })
		} else {
			text += ch
		}
	}
	flush()
	return segments
}

export function likeToRegExp(pattern: LikeSegment[], insensitive: boolean): RegExp {
	const source = pattern
		.map((segment) =>
			segment.kind === "any"
				? "[\\s\\S]*"
				: segment.kind === "one"
					? "[\\s\\S]"
					: segment.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		)
		.join("")
	return new RegExp(`^${source}$`, insensitive ? "iu" : "u")
}
