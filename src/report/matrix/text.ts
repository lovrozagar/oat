/** Text helpers the matrix's renderers share. */

/** `value` safe inside HTML text and a double-quoted attribute. */
export function esc(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

/** `values` without repeats, in first-seen order. */
export function unique(values: string[]): string[] {
	return [...new Set(values)]
}
