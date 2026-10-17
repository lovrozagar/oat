import type { Context, Node, Rule } from "./ast.ts"
import { isTestCode, repoPath } from "./paths.ts"

/*
 * Importing a module runs nothing: module scope only declares. Code that runs at import (a registry
 * validated on load, a cache filled on load) runs in every process that touches the module, in an
 * order nobody chose, so it moves into a function its caller runs, or is marked pure.
 */
const MESSAGE = "module scope runs no code: mark a pure call /* @__PURE__ */ or move it into a function"

const DECLARATIONS = new Set([
	"ClassDeclaration",
	"EmptyStatement",
	"ExportAllDeclaration",
	"FunctionDeclaration",
	"ImportDeclaration",
	"TSDeclareFunction",
	"TSEnumDeclaration",
	"TSExportAssignment",
	"TSImportEqualsDeclaration",
	"TSInterfaceDeclaration",
	"TSModuleDeclaration",
	"TSTypeAliasDeclaration",
])

const EFFECTS = new Set([
	"AssignmentExpression",
	"AwaitExpression",
	"CallExpression",
	"NewExpression",
	"TaggedTemplateExpression",
	"UpdateExpression",
	"YieldExpression",
])

/* Code inside these runs later, when called, not at import. */
const DEFERRED = new Set(["ArrowFunctionExpression", "ClassExpression", "FunctionExpression"])

const PURE = /[@#]__PURE__/

interface Statement extends Node {
	declaration?: Statement | null
	directive?: string
}

function children(node: Node): Node[] {
	const out: Node[] = []
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue
		for (const child of Array.isArray(value) ? value : [value]) {
			if (typeof child === "object" && child !== null && typeof (child as Node).type === "string") out.push(child)
		}
	}
	return out
}

/** The first node under `node` that runs code at import, ignoring pure-marked calls. */
function firstEffect(context: Context, node: Node | null | undefined): Node | null {
	if (node === null || node === undefined || DEFERRED.has(node.type)) return null
	if (EFFECTS.has(node.type)) {
		const pure = context.sourceCode.getCommentsBefore(node).some((comment) => PURE.test(comment.value))
		if (!pure) return node
	}
	for (const child of children(node)) {
		const found = firstEffect(context, child)
		if (found !== null) return found
	}
	return null
}

/* The expressions a statement evaluates at import, or null when the statement itself is the effect. */
function rootsOf(inner: Statement): Array<Node | null> | null {
	if (inner.type === "VariableDeclaration") {
		return (inner as Statement & { declarations: Array<{ init: Node | null }> }).declarations.map((d) => d.init)
	}
	if (inner.type !== "ExportDefaultDeclaration") return null
	const declaration = (inner as Statement & { declaration: Node }).declaration
	return DECLARATIONS.has(declaration.type) ? [] : [declaration]
}

function check(context: Context, statement: Statement): void {
	const inner = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
	if (inner === null || inner === undefined || DECLARATIONS.has(inner.type)) return
	if (inner.type === "ExpressionStatement" && typeof inner.directive === "string") return
	const roots = rootsOf(inner)
	if (roots === null) return context.report({ message: MESSAGE, node: inner })
	for (const root of roots) {
		const effect = firstEffect(context, root)
		if (effect !== null) context.report({ message: MESSAGE, node: effect })
	}
}

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		if (!file.includes("/src/") || isTestCode(file)) return {}
		return {
			Program(program: { body: Statement[] }) {
				for (const statement of program.body) check(context, statement)
			},
		}
	},
}
