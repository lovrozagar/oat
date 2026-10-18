import type { Call, Context, Identifier, ImportNode, Literal, Member, Node, Rule } from "./ast.ts"
import { propertyName } from "./nodes.ts"
import { isTestCode, repoPath } from "./paths.ts"

/*
 * Every request oat sends goes through the client in `src/client/`, which paces it, records it and
 * (with a fence or an allowlist) can refuse it. A `fetch` anywhere else is a request no report
 * shows and no safety control sees. The reference backend, tests and labs are not oat's traffic.
 */
const HOME = "/src/client/request.ts"
const OWN_NETWORK = ["/src/reference/", "/labs/"]
const NODE_HTTP = new Set(["node:http", "node:https", "http", "https"])
const REQUESTING = new Set(["request", "get"])
const MESSAGE =
	"oat sends requests only through the client in src/client/, where pacing, the transcript, the fence and the allowlist apply."

function requestsByCall(node: Call): boolean {
	const callee = node.callee
	if (callee.type === "Identifier") return (callee as { name?: string }).name === "fetch"
	if (callee.type !== "MemberExpression") return false
	const member = callee as Member
	const name = propertyName(member)
	if (member.object.name === "globalThis") return name === "fetch"
	return (member.object.name === "http" || member.object.name === "https") && REQUESTING.has(name)
}

/* `import { get }` or `import { "get" as g }`: the name the module exports. */
function importedName(imported: Identifier & Literal): string {
	return imported.name ?? String(imported.value)
}

function requestsByImport(node: ImportNode): boolean {
	if (node.source.value === "undici") return true
	if (!NODE_HTTP.has(node.source.value)) return false
	return node.specifiers.some(
		(specifier) =>
			specifier.type === "ImportSpecifier" && REQUESTING.has(importedName(specifier.imported as Identifier & Literal)),
	)
}

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		if (file.endsWith(HOME) || isTestCode(file) || OWN_NETWORK.some((part) => file.includes(part))) return {}
		const report = (node: Node): void => context.report({ message: MESSAGE, node })
		return {
			CallExpression(node: Call) {
				if (requestsByCall(node)) report(node)
			},
			ImportDeclaration(node: ImportNode) {
				if (requestsByImport(node)) report(node)
			},
		}
	},
}
