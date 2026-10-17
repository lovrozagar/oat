import type { Context, Rule } from "./ast.ts"

/* The v8 coverage provider honors v8, c8 and istanbul hints alike; a hint hides uncovered code
 * behind a 100% number. Delete the code or give it a case. */
const HINT = /\b(?:v8|c8|istanbul)\s+ignore\b/i
const MESSAGE = "coverage ignore hints are forbidden; delete the code or give it a case"

export const rule: Rule = {
	create(context: Context) {
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					if (HINT.test(comment.value)) context.report({ message: MESSAGE, node: comment })
				}
			},
		}
	},
}
