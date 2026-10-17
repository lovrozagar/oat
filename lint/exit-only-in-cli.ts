import type { Call, Context, Member, Rule } from "./ast.ts"
import { propertyName } from "./nodes.ts"
import { isTestCode, repoPath } from "./paths.ts"

/* Only the CLI ends the process. An exit anywhere else skips teardown and the report, and the
 * records a run made stay behind on someone's backend. */
const HOMES = ["/src/cli.ts", "/src/cli/"]
const MESSAGE = "Only src/cli.ts exits. Return or throw instead, so teardown and the report still run."

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		if (!file.includes("/src/") || isTestCode(file) || HOMES.some((home) => file.includes(home))) return {}
		return {
			CallExpression(node: Call) {
				if (node.callee.type !== "MemberExpression") return
				const member = node.callee as Member
				if (member.object.name === "process" && propertyName(member) === "exit")
					context.report({ message: MESSAGE, node })
			},
		}
	},
}
