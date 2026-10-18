/** JSON pointers into a document, as an internal `$ref` names them. */

/** The node `ref` points at (`#`, `#/`, or `#/a/b`), or `undefined` when nothing is there. */
export function resolvePointer(doc: unknown, ref: string): unknown {
	if (ref === "#" || ref === "#/") return doc
	let node = doc
	for (const seg of ref.slice(2).split("/").map(decodeSegment)) {
		if (node === null || typeof node !== "object" || !Object.hasOwn(node, seg)) return undefined
		node = (node as Record<string, unknown>)[seg]
	}
	return node
}

/** A JSON pointer segment: `~1` and `~0` escapes, then percent-encoding (`%7Bid%7D`). */
export function decodeSegment(seg: string): string {
	const unescaped = seg.replace(/~1/g, "/").replace(/~0/g, "~")
	try {
		return decodeURIComponent(unescaped)
	} catch {
		return unescaped
	}
}
