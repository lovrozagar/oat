import type { Call, Context, Identifier, Member, Node, Rule } from "./ast.ts"
import { propertyName } from "./nodes.ts"
import { repoPath } from "./paths.ts"

/*
 * `String(record[identity])` on a record without its identity is the text "undefined", and it went
 * out in paths, filters and probes. Ids are read with `idOf`, which says when there is none; only
 * the module that owns it reads the field directly. oat's requests are made in the runtime; the
 * reference backend reads its own rows.
 */
const HOME = "/src/runtime/world/records.ts"
const MESSAGE =
	'Read an identity with idOf(record, identity): String() turns a missing one into the text "undefined", which then goes out in a request.'

const namesIdentity = (node: Node): boolean =>
	(node.type === "Identifier" && (node as Identifier).name === "identity") ||
	(node.type === "MemberExpression" && propertyName(node as Member) === "identity")

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		if (!file.includes("/src/runtime/") || file.endsWith(HOME)) return {}
		return {
			CallExpression(node: Call) {
				if (node.callee.type !== "Identifier" || (node.callee as Identifier).name !== "String") return
				const [argument] = node.arguments
				if (argument?.type !== "MemberExpression") return
				const member = argument as Member
				if (member.computed === true && namesIdentity(member.property)) context.report({ message: MESSAGE, node })
			},
		}
	},
}
