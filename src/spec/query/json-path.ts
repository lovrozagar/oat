/**
 * `$`, dots, `[n]`, `[*]`, and `[?(@.key==value)]`.
 * Used by `*From` harvest. Not a full JSONPath implementation.
 */

const FILTER = /^\?\(@\.([A-Za-z_][\w]*)==(true|false|null|"[^"]*"|'[^']*'|[^\s)]+)\)$/

function parseJsonPathLiteral(raw: string): unknown {
	if (raw === "true") return true
	if (raw === "false") return false
	if (raw === "null") return null
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1)
	}
	/* The pattern never captures an empty literal, so a numeric one is never `""` read as 0. */
	if (!Number.isNaN(Number(raw))) return Number(raw)
	return raw
}

function applyJsonPathFilter(node: unknown, token: string): unknown[] | undefined {
	const match = FILTER.exec(token)
	if (match === null || !Array.isArray(node)) return undefined
	/* Both groups are required by the pattern. */
	const key = match[1] as string
	const expected = parseJsonPathLiteral(match[2] as string)
	return node.filter((item) => {
		if (item === null || typeof item !== "object") return false
		return (item as Record<string, unknown>)[key] === expected
	})
}

function tokenizeJsonPath(path: string): string[] {
	const out: string[] = []
	let buf = ""
	for (let i = 0; i < path.length; i++) {
		const ch = path[i]
		if (ch === ".") {
			if (buf !== "") out.push(buf)
			buf = ""
			continue
		}
		if (ch === "[") {
			if (buf !== "") out.push(buf)
			buf = ""
			const end = path.indexOf("]", i)
			if (end === -1) {
				out.push(path.slice(i))
				return out
			}
			out.push(path.slice(i + 1, end))
			i = end
			continue
		}
		buf += ch
	}
	if (buf !== "") out.push(buf)
	return out
}

/** The values one token reaches from one node, `undefined` among them where a key is absent. */
function step(node: unknown, token: string): unknown[] {
	if (token === "*") return Array.isArray(node) ? node : []
	const filtered = applyJsonPathFilter(node, token)
	if (filtered !== undefined) return filtered
	if (node === null || typeof node !== "object") return []
	if (Array.isArray(node)) return /^\d+$/.test(token) ? [node[Number(token)]] : []
	return [(node as Record<string, unknown>)[token]]
}

export function readJsonPathList(body: unknown, path: string): unknown[] {
	const trimmed = path.replace(/^\$\.?/, "")
	if (trimmed === "") return body === undefined ? [] : [body]
	let nodes: unknown[] = [body]
	for (const token of tokenizeJsonPath(trimmed)) {
		nodes = nodes.flatMap((node) => step(node, token)).filter((value) => value !== undefined)
	}
	return nodes
}
