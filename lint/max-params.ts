import type { Context, Identifier, Node, Rule } from "./ast.ts"

/*
 * A function takes at most three parameters. Context-first code may add one more: a first
 * parameter named `ctx`, the run, check or parse context the call happens in. Anything else past
 * three is configuration, and reads better as one options object than as a row of positions.
 * A destructured pattern or a rest parameter counts as one; TypeScript's `this` is not a parameter.
 */
const MAX = 3
const CONTEXT = "ctx"
const MESSAGE = "a function takes at most 3 parameters, plus a first `ctx`: pass the rest as one options object"

type Param = Identifier | (Node & { type: "TSParameterProperty"; parameter: Identifier })

interface FunctionNode extends Node {
	params: Param[]
}

/* A parameter's own name, through a constructor's `private readonly` property. */
function nameOf(param: Param): string | undefined {
	return "parameter" in param ? param.parameter.name : param.name
}

function counted(node: FunctionNode): number {
	const params = node.params.filter((param) => nameOf(param) !== "this")
	const first = params[0]
	return first !== undefined && nameOf(first) === CONTEXT ? params.length - 1 : params.length
}

export const rule: Rule = {
	create(context: Context) {
		const check = (node: FunctionNode): void => {
			if (counted(node) > MAX) context.report({ message: MESSAGE, node })
		}
		return {
			ArrowFunctionExpression: check,
			FunctionDeclaration: check,
			FunctionExpression: check,
			TSDeclareFunction: check,
			TSEmptyBodyFunctionExpression: check,
		}
	},
}
