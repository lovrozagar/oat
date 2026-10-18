/**
 * Reading a value out of a JSON body by path, once. `$.a.b`, `a.b`, `$.items[0].id` and
 * `$.items.0.id` are dotted paths; a leading `/` makes it a JSON pointer (`/items/0/id`).
 * Auth flows, async receipts, x-wait and invite pointers all name values this way.
 */

export function readPath(body: unknown, pointer: string): unknown {
	if (pointer.startsWith("/")) return readJsonPointer(body, pointer)
	/* A filter names items, not one node: the first match is the one a saved value means. */
	if (FILTER_RE.test(pointer)) return readAll(body, pointer)[0]
	/* `$.messages[0].id` and `$.messages.0.id` name the same node: brackets are read as segments. */
	return pointer
		.replace(/^\$\.?/, "")
		.replace(/\[(\d+)\]/g, ".$1")
		.split(".")
		.filter(Boolean)
		.reduce(step, body)
}

/* One segment down: a property of an object, an index of an array, nothing below a primitive. */
function step(node: unknown, segment: string): unknown {
	if (node === null || typeof node !== "object") return undefined
	if (!Array.isArray(node)) return (node as Record<string, unknown>)[segment]
	const index = Number.parseInt(segment, 10)
	return Number.isNaN(index) ? undefined : node[index]
}

function readJsonPointer(body: unknown, pointer: string): unknown {
	if (pointer === "/") return body
	return pointer
		.slice(1)
		.split("/")
		.map((raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~"))
		.reduce(step, body)
}

/* `[?(@.field==value)]`: a quoted string, a number, true, false or null. */
const FILTER_RE = /\[\?\(@\.([A-Za-z0-9_]+)==(?:'([^']*)'|"([^"]*)"|([^)\]]+))\)\]/

/* The value a filter compares with. The regex matched, so exactly one of groups 2 to 4 is set. */
function filterValue(match: RegExpExecArray): unknown {
	if (match[2] !== undefined) return match[2]
	if (match[3] !== undefined) return match[3]
	const literal = (match[4] as string).trim()
	if (literal === "true") return true
	if (literal === "false") return false
	if (literal === "null") return null
	const number = Number(literal)
	return Number.isNaN(number) ? literal : number
}

/** Where a path first fans out or narrows: the path above, the path below, and the items that go on. */
interface Branch {
	head: string
	rest: string
	keeps: (item: unknown) => boolean
}

function keepsEvery(): boolean {
	return true
}

/* The items whose field equals the filter's value. Group 1, the field, is not optional. */
function keepsMatching(filter: RegExpExecArray): (item: unknown) => boolean {
	const field = filter[1] as string
	const value = filterValue(filter)
	return (item) => item !== null && typeof item === "object" && (item as Record<string, unknown>)[field] === value
}

function branchOf(path: string): Branch | undefined {
	const star = path.indexOf("[*]")
	const filter = FILTER_RE.exec(path)
	if (filter === null || (star >= 0 && star < filter.index)) {
		return star < 0 ? undefined : { head: path.slice(0, star), keeps: keepsEvery, rest: path.slice(star + 3) }
	}
	const head = path.slice(0, filter.index)
	return { head, keeps: keepsMatching(filter), rest: path.slice(filter.index + filter[0].length) }
}

/**
 * Every node `path` names, fanning out at `[*]` and narrowing at `[?(@.field==value)]`:
 * `$.items[*].name` is each item's name, `$.items[?(@.id=='a')].name` the name of the item whose
 * id is `a`. A path with neither names at most one node, the same one `readPath` returns.
 */
export function readAll(body: unknown, path: string): unknown[] {
	const branch = branchOf(path)
	if (branch === undefined) {
		const node = readPath(body, path)
		return node === undefined ? [] : [node]
	}
	const list = branch.head === "$" || branch.head === "" ? body : readPath(body, branch.head)
	if (!Array.isArray(list)) return []
	return list.filter(branch.keeps).flatMap((item) => (branch.rest === "" ? [item] : readAll(item, `$${branch.rest}`)))
}
