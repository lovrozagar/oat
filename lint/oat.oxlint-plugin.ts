/*
 * oat's own oxlint rules, loaded through `jsPlugins` in `.oxlintrc.json`. Each one turns a
 * guarantee the test suite depends on into something the linter enforces at the line that would
 * break it.
 *
 * `oat/proven-id-origin`: teardown deletes what was recorded, and only a `ProvenId` can be recorded.
 * Making one by a cast anywhere but `src/runtime/proven-id.ts` would let an id oat merely sent —
 * the bug that deleted other tenants' rows — back into the ledger.
 */

/* The slice of oxlint's plugin API this file uses (oxlint ships no importable plugin types). */
interface Node {
	type: string
}
interface Assertion extends Node {
	typeAnnotation: Node
}
interface Context {
	filename: string
	sourceCode: { getText: (node: Node) => string }
	report: (diagnostic: { message: string; node: Node }) => void
}

const PROVEN_ID_HOME = "src/runtime/proven-id.ts"

const provenIdOrigin = {
	create(context: Context) {
		if (context.filename.replaceAll("\\", "/").endsWith(PROVEN_ID_HOME)) return {}
		const check = (node: Assertion) => {
			/* `ProvenId`, `ids.ProvenId`, `import("./proven-id.ts").ProvenId` — the name, however reached. */
			if (!/(^|[.\s])ProvenId$/.test(context.sourceCode.getText(node.typeAnnotation).trim())) return
			context.report({
				message:
					"Only src/runtime/proven-id.ts makes a ProvenId. Use answeredId, returnedId, listedIds or receiptId, " +
					"so every id teardown deletes is one the backend gave back.",
				node,
			})
		}
		return { TSAsExpression: check, TSTypeAssertion: check }
	},
}

export default {
	meta: { name: "oat" },
	rules: {
		"proven-id-origin": provenIdOrigin,
	},
}
