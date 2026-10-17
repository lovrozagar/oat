import type { Binary, Context, Literal, Member, Node, Rule } from "./ast.ts"
import { propertyName } from "./nodes.ts"
import { isTestCode, repoPath } from "./paths.ts"

/*
 * What a filter or sort grammar can write is the renderer's to say. A check that compares a
 * grammar's name answers for the presets and is wrong for every declared template, so it asks the
 * renderer (`canWriteOr`, `canGroupAnd`, a `null` term) instead. Only the renderer, the reference
 * backend and tests may name a grammar.
 */
const HOMES = ["/src/spec/conventions.ts", "/src/spec/filter-render.ts", "/src/reference/"]
const FIELDS = new Set(["grammar", "sortGrammar"])
const MESSAGE =
	"Ask the renderer what this grammar can write (canWriteOr, canGroupAnd, a null term) instead of comparing its name: a declared template has none of the presets' names."

const isGrammarField = (node: Node): boolean =>
	node.type === "MemberExpression" && FIELDS.has(propertyName(node as Member))
const isStringLiteral = (node: Node): boolean => node.type === "Literal" && typeof (node as Literal).value === "string"

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		if (isTestCode(file) || HOMES.some((part) => file.includes(part))) return {}
		return {
			BinaryExpression(node: Binary) {
				if (node.operator !== "===" && node.operator !== "!==") return
				const named =
					(isGrammarField(node.left) && isStringLiteral(node.right)) ||
					(isGrammarField(node.right) && isStringLiteral(node.left))
				if (named) context.report({ message: MESSAGE, node })
			},
		}
	},
}
