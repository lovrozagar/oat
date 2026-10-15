/*
 * oat's own oxlint rules, loaded through `jsPlugins` in `.oxlintrc.json`. Each one turns a
 * guarantee the test suite depends on into something the linter enforces at the line that would
 * break it.
 *
 * `oat/proven-id-origin`: teardown deletes what was recorded, and only a `ProvenId` can be recorded.
 * Making one by a cast anywhere but `src/runtime/proven-id.ts` would let an id oat merely sent —
 * the bug that deleted other tenants' rows — back into the ledger.
 *
 * `oat/network-through-client`: every request oat sends goes through `src/runtime/client.ts`, which
 * paces it, records it and (with a fence or an allowlist) can refuse it. A `fetch` anywhere else is
 * a request no report shows and no safety control sees. The reference backend, tests and labs are
 * not oat's traffic and stay free to make their own.
 */

/* The slice of oxlint's plugin API this file uses (oxlint ships no importable plugin types). */
interface Node {
	type: string
}
interface Assertion extends Node {
	typeAnnotation: Node
}
interface Identifier extends Node {
	name?: string
}
interface Member extends Node {
	object: Identifier
	property: Identifier
}
interface Call extends Node {
	callee: Identifier | Member
}
interface ImportNode extends Node {
	source: { value: string }
	specifiers: Array<{ type: string; imported?: Identifier }>
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

const CLIENT_HOME = "src/runtime/client.ts"
const OWN_NETWORK = ["/src/reference/", "/test/", "/labs/"]
const NODE_HTTP = new Set(["node:http", "node:https", "http", "https"])
const REQUESTING = new Set(["request", "get"])
const OUTSIDE_THE_CLIENT =
	"oat sends requests only through src/runtime/client.ts, where pacing, the transcript, the fence and the allowlist apply."

const networkThroughClient = {
	create(context: Context) {
		const file = context.filename.replaceAll("\\", "/")
		if (file.endsWith(CLIENT_HOME) || OWN_NETWORK.some((part) => file.includes(part))) return {}
		const report = (node: Node) => context.report({ message: OUTSIDE_THE_CLIENT, node })
		return {
			CallExpression(node: Call) {
				const callee = node.callee
				if (callee.type === "Identifier" && callee.name === "fetch") return report(node)
				if (callee.type !== "MemberExpression") return
				const member = callee as Member
				const object = member.object.name
				const property = member.property.name
				if (object === "globalThis" && property === "fetch") return report(node)
				if ((object === "http" || object === "https") && property !== undefined && REQUESTING.has(property)) {
					return report(node)
				}
			},
			ImportDeclaration(node: ImportNode) {
				if (node.source.value === "undici") return report(node)
				if (!NODE_HTTP.has(node.source.value)) return
				const requesting = node.specifiers.some(
					(specifier) =>
						specifier.type === "ImportSpecifier" &&
						specifier.imported?.name !== undefined &&
						REQUESTING.has(specifier.imported.name),
				)
				if (requesting) report(node)
			},
		}
	},
}

export default {
	meta: { name: "oat" },
	rules: {
		"network-through-client": networkThroughClient,
		"proven-id-origin": provenIdOrigin,
	},
}
