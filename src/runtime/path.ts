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
