import type { Comment, Context, Node, Rule } from "./ast.ts"
import { isTestCode, repoPath } from "./paths.ts"

/*
 * Run state lives on the run's context. A module-scope `let`, `var` or constructed object outlives
 * the run and leaks between runs in one process (tests, the conformance pool), so it needs one of
 * the allowlisted reasons, written on its line or the line above. A constructed table typed
 * `ReadonlySet` or `ReadonlyMap` is a constant: the compiler refuses every write to it.
 */
export const REASONS = ["compiled-schema", "async-context"] as const

const REASON = new RegExp(`^per-process-constant:\\s*(?:${REASONS.join("|")})\\b`)
const MESSAGE = `module-scope state needs \`// per-process-constant: <reason>\` with an allowlisted reason (${REASONS.join(", ")})`
const WRAPPERS = new Set(["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"])

interface Declarator {
	id: Node & { typeAnnotation?: Node | null }
	init: Wrapped | null
}
interface Declaration extends Node {
	kind: string
	declarations: Declarator[]
}
interface Wrapped extends Node {
	expression?: Wrapped
}

function unwrap(node: Wrapped | null | undefined): Wrapped | null | undefined {
	let current = node
	while (current?.expression !== undefined && WRAPPERS.has(current.type)) current = current.expression
	return current
}

const READONLY = /^:\s*Readonly(?:Set|Map)</

function isState(context: Context, declaration: Declaration): boolean {
	if (declaration.kind !== "const") return true
	return declaration.declarations.some((d) => {
		if (unwrap(d.init)?.type !== "NewExpression") return false
		const annotation = d.id.typeAnnotation
		return annotation === null || annotation === undefined || !READONLY.test(context.sourceCode.getText(annotation))
	})
}

function allowed(context: Context, statement: Node): boolean {
	const text = context.sourceCode.getText()
	const sameLine = context.sourceCode
		.getCommentsAfter(statement)
		.filter((comment: Comment) => !text.slice(statement.end, comment.start).includes("\n"))
	const before = context.sourceCode.getCommentsBefore(statement).slice(-1)
	return [...before, ...sameLine].some((comment) => REASON.test(comment.value.trim()))
}

export const rule: Rule = {
	create(context: Context) {
		const file = repoPath(context.filename)
		if (!file.includes("/src/") || isTestCode(file)) return {}
		return {
			VariableDeclaration(node: Declaration) {
				const statement = node.parent?.type === "ExportNamedDeclaration" ? node.parent : node
				if (statement.parent?.type !== "Program" || !isState(context, node)) return
				if (!allowed(context, statement)) context.report({ message: MESSAGE, node })
			},
		}
	},
}
