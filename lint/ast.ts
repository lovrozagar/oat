/* The slice of oxlint's plugin API oat's rules use (oxlint ships no importable plugin types). */

export interface Node {
	type: string
	start: number
	end: number
	parent?: Node | null
}
export interface Identifier extends Node {
	name?: string
}
export interface Literal extends Node {
	value?: unknown
}
export interface Member extends Node {
	object: Identifier
	property: Identifier
	computed?: boolean
}
export interface Call extends Node {
	callee: Identifier | Member
	arguments: Node[]
}
export interface Assertion extends Node {
	typeAnnotation: Node
}
export interface Binary extends Node {
	operator: string
	left: Node
	right: Node
}
export interface ImportNode extends Node {
	source: { value: string }
	specifiers: Array<{ type: string; imported?: Identifier & Literal }>
}
export interface Comment {
	type: string
	value: string
	start: number
	end: number
}
export interface Context {
	filename: string
	sourceCode: {
		getText: (node?: Node) => string
		getAllComments: () => Comment[]
		getCommentsBefore: (node: Node) => Comment[]
		getCommentsAfter: (node: Node) => Comment[]
	}
	report: (diagnostic: { message: string; node: Node | Comment }) => void
}
export type Visitors = Record<string, ((node: never) => void) | undefined>
export interface Rule {
	create: (context: Context) => Visitors
}
