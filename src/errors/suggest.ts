/* Suggestions for a misspelled name, for the error that refuses it. */

function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i)
	for (let i = 1; i <= a.length; i++) {
		let diagonal = row[0] as number
		row[0] = i
		for (let j = 1; j <= b.length; j++) {
			const above = row[j] as number
			row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
			diagonal = above
		}
	}
	return row[b.length] as number
}

/** Up to three candidates closest to `name` by edit distance, nearest first; none when nothing is close. */
export function nearest(name: string, candidates: Iterable<string>): string[] {
	return [...candidates]
		.map((candidate) => ({ candidate, d: distance(name, candidate) }))
		.filter((item) => item.d <= Math.max(3, Math.floor(name.length / 3)))
		.sort((a, b) => a.d - b.d || a.candidate.localeCompare(b.candidate))
		.slice(0, 3)
		.map((item) => item.candidate)
}

/** The sentence an error appends to suggest the nearest of `candidates`, or nothing when none is close. */
export function didYouMean(name: string, candidates: Iterable<string>): string {
	const close = nearest(name, candidates)
	return close.length === 0 ? "" : ` Did you mean: ${close.join(", ")}?`
}
