import type { FilterNode } from "../query-types.ts"
import { likeToRegExp } from "./like.ts"
import { compareScalar, equal, isNull } from "./scalar.ts"

type Row = Record<string, unknown>
type Node<K extends FilterNode["kind"]> = Extract<FilterNode, { kind: K }>

/** The in-memory evaluation of a filter — the reference semantics the SQL compilers match. */
export function evaluate(node: FilterNode, row: Row): boolean {
	switch (node.kind) {
		case "const":
			return node.value
		case "and":
			return node.children.every((child) => evaluate(child, row))
		case "or":
			return node.children.some((child) => evaluate(child, row))
		case "isnull":
			return isNull(row[node.field]) !== node.negate
		case "cmp":
			return evaluateCmp(node, row)
		case "in": {
			const value = row[node.field]
			if (isNull(value)) return node.negate
			const hit = node.values.some((member) => equal(value, member, node.asText))
			return hit !== node.negate
		}
		case "like": {
			const value = row[node.field]
			return typeof value === "string" && likeToRegExp(node.pattern, node.insensitive).test(value)
		}
		case "contains":
			return evaluateContains(node, row)
		case "search":
			return evaluateSearch(node, row)
	}
}

function evaluateCmp(node: Node<"cmp">, row: Row): boolean {
	const value = row[node.field]
	if (isNull(value)) return node.nullsMatch
	if (node.op === "eq") return equal(value, node.value, node.asText)
	if (node.op === "neq") return !equal(value, node.value, node.asText)
	const delta = compareScalar(value, node.value, node.asText)
	if (node.op === "gt") return delta > 0
	if (node.op === "gte") return delta >= 0
	if (node.op === "lt") return delta < 0
	return delta <= 0
}

function evaluateContains(node: Node<"contains">, row: Row): boolean {
	const value = row[node.field]
	if (!Array.isArray(value)) return false
	return node.substring
		? value.some((element) => String(element).includes(node.value))
		: value.some((element) => String(element) === node.value)
}

function evaluateSearch(node: Node<"search">, row: Row): boolean {
	const fold = (text: string): string => (node.caseSensitive ? text : text.toLowerCase())
	const needle = fold(node.token)
	return node.fields.some((field) => {
		const value = row[field]
		if (isNull(value)) return false
		const text = fold(String(value))
		return node.mode === "prefix" ? text.startsWith(needle) : text.includes(needle)
	})
}
