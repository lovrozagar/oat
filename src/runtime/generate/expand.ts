/** Expands the common regex subset — classes, escapes, quantifiers, groups — to one example. */

/** One atom of the pattern and the source after it. */
interface Step {
	atom: string
	rest: string
}

function classAtom(source: string, index: number): Step | undefined {
	const close = source.indexOf("]", 1)
	if (close < 0) return undefined
	const body = source.slice(1, close).replace(/^\^/, "")
	let atom = body.startsWith("\\d") ? String(index % 10) : body.startsWith("\\w") ? "a" : (body[0] ?? "a")
	/* A range: its first character, which is there since the dash follows it. */
	if (body[1] === "-" && body[2] !== undefined) atom = body[0] as string
	return { atom, rest: source.slice(close + 1) }
}

function escapeAtom(source: string, index: number): Step {
	const next = source[1] ?? ""
	const atom = next === "d" ? String(index % 10) : next === "w" ? "a" : next === "s" ? " " : next
	return { atom, rest: source.slice(2) }
}

function groupAtom(source: string, index: number): Step | undefined {
	const close = source.indexOf(")")
	if (close < 0) return undefined
	/* `split` always yields at least one alternative. */
	const inner = source.slice(1, close).replace(/^\?:/, "").split("|")[0] as string
	return { atom: expand(inner, index) ?? "", rest: source.slice(close + 1) }
}

/** The next atom; `undefined` for a pattern this cannot expand, `null` where the expansion stops. */
function atomAt(source: string, index: number): Step | undefined | null {
	const ch = source[0] as string
	if (ch === "[") return classAtom(source, index)
	if (ch === "\\") return escapeAtom(source, index)
	if (ch === "(") return groupAtom(source, index)
	if (ch === ".") return { atom: "a", rest: source.slice(1) }
	if (ch === "|" || ch === ")") return null
	return { atom: ch, rest: source.slice(1) }
}

function quantity(source: string): { count: number; rest: string } {
	const q = source[0]
	if (q === "+" || q === "*" || q === "?") return { count: q === "+" ? 2 : 1, rest: source.slice(1) }
	const braces = /^\{(\d+)(,(\d*))?\}/.exec(source)
	if (braces !== null) return { count: Number(braces[1]), rest: source.slice(braces[0].length) }
	return { count: 1, rest: source }
}

export function expand(pattern: string, index: number): string | undefined {
	let source = pattern.replace(/^\^/, "").replace(/\$$/, "")
	let out = ""
	let guard = 0
	while (source.length > 0 && guard++ < 512) {
		const step = atomAt(source, index)
		if (step === undefined) return undefined
		if (step === null) break
		const repeat = quantity(step.rest)
		source = repeat.rest
		out += step.atom.repeat(repeat.count)
	}
	return out
}
