import type { Context, Node, Rule } from "./ast.ts"
import { repoPath } from "./paths.ts"

/*
 * An `index.ts` names a module's surface and holds nothing else: no logic to test, no barrel
 * `export *` that widens the surface whenever a sibling adds an export. Coverage excludes index
 * files on the strength of this rule.
 */
const MESSAGE = 'an index.ts holds only named re-exports: `export { a } from "./a.ts"`'

interface Statement extends Node {
	source?: unknown
	declaration?: unknown
}

const isNamedReExport = (statement: Statement): boolean =>
	statement.type === "ExportNamedDeclaration" && statement.source !== null && statement.source !== undefined

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		if (!file.includes("/src/") || !file.endsWith("/index.ts")) return {}
		return {
			Program(program: { body: Statement[] }) {
				for (const statement of program.body) {
					if (!isNamedReExport(statement)) context.report({ message: MESSAGE, node: statement })
				}
			},
		}
	},
}
