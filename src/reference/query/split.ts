/** `and(...)` or `or(...)`: the combinator and what it holds. Both groups take part in every match. */
export const GROUP = /^(and|or)\((.*)\)$/s

/** Splits on commas at paren depth zero — shared by the filter and order grammars. */
export function splitTopLevel(input: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]
		if (ch === "(") depth++
		else if (ch === ")") depth--
		else if (ch === "," && depth === 0) {
			parts.push(input.slice(start, i))
			start = i + 1
		}
	}
	parts.push(input.slice(start))
	return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/** How many terms a filter expression holds, counted through every group. */
export function countTerms(expression: string): number {
	const group = GROUP.exec(expression.trim())
	if (group !== null) return splitTopLevel(group[2] as string).reduce((sum, part) => sum + countTerms(part), 0)
	return 1
}
