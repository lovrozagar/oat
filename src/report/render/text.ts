/** Small text helpers the reports share. */

/** A file-name-safe stem: lowercase words joined by dashes, at most 60 characters. */
export function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60)
}

/** A body as a reader can take it in: text as is, anything else as JSON, cut at `max` characters. */
export function truncate(value: unknown, max = 600): string {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
	return text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text
}

/** `text` broken into lines of at most `width` characters, at whitespace. */
export function wrap(text: string, width: number): string[] {
	const words = text.split(/\s+/)
	const lines: string[] = []
	let current = ""
	for (const word of words) {
		if (current.length + word.length + 1 > width) {
			lines.push(current)
			current = word
		} else {
			current = current === "" ? word : `${current} ${word}`
		}
	}
	if (current !== "") lines.push(current)
	return lines
}

/** The entities a run tested, by name while there are few enough to read. */
export function entityList(names: readonly string[]): string {
	if (names.length === 0) return "none"
	if (names.length <= 12) return names.join(", ")
	return `${names.length} entities`
}

/** The first `keep` names, and how many more there are. */
export function named(names: readonly string[], keep = 6): string {
	if (names.length <= keep) return names.join(", ")
	return `${names.slice(0, keep).join(", ")} +${names.length - keep} more`
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} bytes`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
	return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
