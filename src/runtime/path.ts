/**
 * Reading a value out of a JSON body by path, once. `$.a.b`, `a.b`, `$.items[0].id` and
 * `$.items.0.id` are dotted paths; a leading `/` makes it a JSON pointer (`/items/0/id`).
 * Auth flows, async receipts, x-wait and invite pointers all name values this way.
 */

export function readPath(body: unknown, pointer: string): unknown {
	if (pointer.startsWith("/")) return readJsonPointer(body, pointer)
	let node: unknown = body
	/* `$.messages[0].id` and `$.messages.0.id` name the same node: brackets are read as segments. */
	for (const segment of pointer
		.replace(/^\$\.?/, "")
		.replace(/\[(\d+)\]/g, ".$1")
		.split(".")
		.filter(Boolean)) {
		if (node === null || typeof node !== "object") return undefined
		const index = Number.parseInt(segment, 10)
		node = Array.isArray(node)
			? Number.isNaN(index)
				? undefined
				: node[index]
			: (node as Record<string, unknown>)[segment]
	}
	return node
}

function readJsonPointer(body: unknown, pointer: string): unknown {
	if (pointer === "/") return body
	let node: unknown = body
	for (const raw of pointer.slice(1).split("/")) {
		const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~")
		if (node === null || typeof node !== "object") return undefined
		const index = Number.parseInt(segment, 10)
		node = Array.isArray(node)
			? Number.isNaN(index)
				? undefined
				: node[index]
			: (node as Record<string, unknown>)[segment]
	}
	return node
}

/* `[?(@.field==value)]`: a quoted string, a number, true, false or null. */
const FILTER_RE = /\[\?\(@\.([A-Za-z0-9_]+)==(?:'([^']*)'|"([^"]*)"|([^)\]]+))\)\]/

function filterValue(match: RegExpExecArray): unknown {
	if (match[2] !== undefined) return match[2]
	if (match[3] !== undefined) return match[3]
	const literal = (match[4] ?? "").trim()
	if (literal === "true") return true
	if (literal === "false") return false
	if (literal === "null") return null
	const number = Number(literal)
	return Number.isNaN(number) ? literal : number
}

/**
 * Every node `path` names, fanning out at `[*]` and narrowing at `[?(@.field==value)]`:
 * `$.items[*].name` is each item's name, `$.items[?(@.id=='a')].name` the name of the item whose
 * id is `a`. A path with neither names at most one node, the same one `readPath` returns.
 */
export function readAll(body: unknown, path: string): unknown[] {
	const star = path.indexOf("[*]")
	const filter = FILTER_RE.exec(path)
	if (star < 0 && filter === null) {
		const node = readPath(body, path)
		return node === undefined ? [] : [node]
	}
	const fansOut = filter === null || (star >= 0 && star < filter.index)
	const at = fansOut ? star : (filter?.index ?? 0)
	const head = path.slice(0, at)
	const rest = path.slice(at + (fansOut ? 3 : (filter?.[0].length ?? 0)))
	const list = head === "$" || head === "" ? body : readPath(body, head)
	if (!Array.isArray(list)) return []
	const kept =
		fansOut || filter === null
			? list
			: list.filter(
					(item) =>
						item !== null &&
						typeof item === "object" &&
						(item as Record<string, unknown>)[filter[1] ?? ""] === filterValue(filter),
				)
	return kept.flatMap((item) => (rest === "" ? [item] : readAll(item, `$${rest}`)))
}
