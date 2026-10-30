/**
 * Whether a field a write was sent reads back as stored. A backend may store a string trimmed or
 * case-folded, as one lowercasing a slug does: that is the value it was sent, normalized, not a
 * field it discarded. Any other difference is.
 */
export function storedAs(stored: unknown, sent: unknown): boolean {
	if (typeof stored === "string" && typeof sent === "string") return folded(stored) === folded(sent)
	return JSON.stringify(stored) === JSON.stringify(sent)
}

function folded(text: string): string {
	return text.trim().toLowerCase()
}
