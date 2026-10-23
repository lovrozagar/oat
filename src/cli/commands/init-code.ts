/*
 * Code as oxfmt lays it out (tabs, no semicolons, 120 columns), so formatting a file written from it
 * changes nothing: an object or list stays on one line when it fits and holds no comment, and
 * otherwise takes one entry per line.
 */

/** Code for a value: an expression, a list of expressions, or an object whose fields may carry comments. */
export type Code = string | Code[] | Field[]
/** An object's entry, with comments above it, or a comment line of its own. */
export type Field = { key: string; value: Code; comments?: string[] } | { comment: string }

const WIDTH = 120
/* oxfmt measures a tab as two columns. */
const TAB = 2
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

const tabs = (depth: number): string => "\t".repeat(depth)
/** A string literal. */
export const quote = (text: string): string => JSON.stringify(text)
const isFieldList = (code: Code[] | Field[]): code is Field[] => code.length === 0 || typeof code[0] !== "string"
const keyOf = (key: string): string => (IDENTIFIER.test(key) ? key : quote(key))

/** The code on one line, or nothing when it holds a comment and so cannot be. */
function inline(code: Code): string | undefined {
	if (typeof code === "string") return code
	if (!isFieldList(code)) return `[${code.map(inline).join(", ")}]`
	if (code.length === 0) return "{}"
	const parts: string[] = []
	for (const field of code) {
		if ("comment" in field || field.comments !== undefined) return undefined
		const value = inline(field.value)
		if (value === undefined) return undefined
		parts.push(`${keyOf(field.key)}: ${value}`)
	}
	return `{ ${parts.join(", ")} }`
}

/** `key: value,` at `depth`: on one line when it fits and holds no comment, else one entry per line. */
function lines(key: string, code: Code, depth: number): string[] {
	const head = `${tabs(depth)}${keyOf(key)}: `
	const one = inline(code)
	const fits = one !== undefined && head.length + depth * (TAB - 1) + one.length + 1 <= WIDTH
	if (typeof code === "string" || fits) return [`${head}${one},`]
	if (isFieldList(code)) return [`${head}{`, ...fieldLines(code, depth + 1), `${tabs(depth)}},`]
	return [`${head}[`, ...code.map((item) => `${tabs(depth + 1)}${inline(item)},`), `${tabs(depth)}],`]
}

/** An object's fields at `depth`, each with its comments above it. */
export function fieldLines(fields: readonly Field[], depth: number): string[] {
	return fields.flatMap((field) =>
		"comment" in field
			? [`${tabs(depth)}// ${field.comment}`]
			: [
					...(field.comments ?? []).map((comment) => `${tabs(depth)}// ${comment}`),
					...lines(field.key, field.value, depth),
				],
	)
}
