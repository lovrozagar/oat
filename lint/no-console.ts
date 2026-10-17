import type { Context, Member, Rule } from "./ast.ts"
import { propertyName } from "./nodes.ts"
import { isTestCode, repoPath } from "./paths.ts"

/* The writer is the one owner of terminal output: every other line writes through it, so a test
 * can capture it and the progress line and the report never interleave. */
const WRITER = "/src/cli/writer.ts"
const STREAMS = new Set(["stdout", "stderr"])
const MESSAGE = "terminal output belongs to src/cli/writer.ts; write through the writer"

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		if (!file.includes("/src/") || file.endsWith(WRITER) || isTestCode(file)) return {}
		return {
			MemberExpression(node: Member) {
				if (node.object.type !== "Identifier") return
				const console = node.object.name === "console"
				const stream = node.object.name === "process" && STREAMS.has(propertyName(node))
				if (console || stream) context.report({ message: MESSAGE, node })
			},
		}
	},
}
