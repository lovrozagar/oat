/**
 * The small JSON pointer `x-bind` reads with: `$.a.b[0].c` and `$.a[*].c`.
 */

/** `$.a.b[0].c` and `$.a[*].c`. A `*` step returns every match; otherwise the first. */
export function valueAt(root: unknown, pointer: string): unknown {
	if (!pointer.startsWith("$")) return undefined
	const parts = pointerTokens(pointer)
	let current: unknown[] = [root]
	for (const part of parts) current = current.flatMap((node) => step(node, part))
	if (parts.includes("*")) return current.filter((item) => item !== undefined)
	return current[0]
}

/** What one token reaches from one node: every item for `*`, else the one child, else nothing. */
function step(node: unknown, part: string | number): unknown[] {
	if (part === "*") return Array.isArray(node) ? [...node] : []
	if (node === null || typeof node !== "object") return []
	if (typeof part === "number") return Array.isArray(node) ? [node[part]] : []
	return [(node as Record<string, unknown>)[part]]
}

function pointerTokens(pointer: string): Array<string | number | "*"> {
	const body = pointer.startsWith("$.") ? pointer.slice(2) : pointer.slice(1)
	const tokens: Array<string | number | "*"> = []
	const re = /([^[\].]+)|\[(\*|\d+)\]/g
	for (let match = re.exec(body); match !== null; match = re.exec(body)) {
		if (match[1] !== undefined) tokens.push(match[1])
		else if (match[2] === "*") tokens.push("*")
		else tokens.push(Number(match[2]))
	}
	return tokens
}
