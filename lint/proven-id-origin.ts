import type { Assertion, Context, Rule } from "./ast.ts"
import { repoPath } from "./paths.ts"

/*
 * Teardown deletes what was recorded, and only a `ProvenId` can be recorded. Making one by a cast
 * anywhere but `src/runtime/proven-id.ts` would let an id oat merely sent (the bug that deleted
 * other tenants' rows) back into the ledger.
 */
const HOME = "/src/runtime/proven-id.ts"
const MESSAGE =
	"Only src/runtime/proven-id.ts makes a ProvenId. Use answeredId, returnedId, listedIds or receiptId, " +
	"so every id teardown deletes is one the backend gave back."

/* `ProvenId`, `ids.ProvenId`, `import("./proven-id.ts").ProvenId`: the name, however reached. */
const PROVEN_ID = /(^|[.\s])ProvenId$/

export const rule: Rule = {
	create(context: Context) {
		if (repoPath(context.filename).endsWith(HOME)) return {}
		const check = (node: Assertion): void => {
			if (PROVEN_ID.test(context.sourceCode.getText(node.typeAnnotation).trim()))
				context.report({ message: MESSAGE, node })
		}
		return { TSAsExpression: check, TSTypeAssertion: check }
	},
}
