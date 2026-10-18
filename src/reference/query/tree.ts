import type { FilterNode } from "../query-types.ts"

/** The conjunction of the predicates given, `null`s skipped: one alone is itself, none matches everything. */
export function and(...nodes: Array<FilterNode | null>): FilterNode {
	const children = nodes.filter((node): node is FilterNode => node !== null)
	if (children.length === 0) return { kind: "const", value: true }
	if (children.length === 1) return children[0] as FilterNode
	return { children, kind: "and" }
}

/** Fields a filter expression names, for the tombstone rule (an explicit mention lifts it). */
export function fieldsIn(node: FilterNode): string[] {
	switch (node.kind) {
		case "and":
		case "or":
			return node.children.flatMap(fieldsIn)
		case "const":
			return []
		case "search":
			return node.fields
		default:
			return [node.field]
	}
}
