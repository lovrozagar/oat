import type { RequestOptions } from "../../../../../client/types.ts"
import type { Record_ } from "../../../../world/records.ts"
import type { Answer, Responder } from "../../../__fixtures__/harness.ts"

/*
 * An in-memory backend for the widget listing, speaking the postgrest filter grammar —
 * `field.op.value`, `and(...)`, `or(...)`, `in.(a,b)`, `is.null`. Correct by default; each defect a
 * filter check exists for is one knob in `Behavior`.
 */

export const PATH = "/v1/widgets"

/** The fields a widget has: a term on any other is a term on an unknown field. */
export const PROPERTIES = {
	amount: { type: "number" },
	id: { type: "string" },
	name: { type: "string" },
	note: { type: ["string", "null"] },
	score: { type: "number" },
	status: { type: "string" },
	tags: { items: { type: "string" }, type: "array" },
} as const

/** One operator: does a row's value satisfy it, given the term's argument as written. */
export type OpImpl = (value: unknown, arg: string) => boolean

const present = (value: unknown): boolean => value !== null && value !== undefined

/** The members of an `in.(a,b)` argument. */
export function members(arg: string): string[] {
	const inner = arg.replace(/^\(/, "").replace(/\)$/, "")
	return inner === "" ? [] : inner.split(",")
}

/** `*` is the wildcard; everything else, `%` included, is literal. */
function likePattern(arg: string, flags: string): RegExp {
	const body = arg
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\%]/g, "\\$&"))
		.join(".*")
	return new RegExp(`^${body}$`, flags)
}

const compare =
	(test: (value: number, threshold: number) => boolean): OpImpl =>
	(value, arg) =>
		typeof value === "number" && test(value, Number(arg))

const negate: OpImpl = (value, arg) => !(present(value) && String(value) === arg)

/** The operators as a correct backend applies them. */
export const OPS: Readonly<Record<string, OpImpl>> = {
	contains: (value, arg) => Array.isArray(value) && value.some((item) => String(item) === arg),
	eq: (value, arg) => present(value) && String(value) === arg,
	gt: compare((value, threshold) => value > threshold),
	gte: compare((value, threshold) => value >= threshold),
	ilike: (value, arg) => typeof value === "string" && likePattern(arg, "i").test(value),
	in: (value, arg) => present(value) && members(arg).includes(String(value)),
	is: (value, arg) => (arg === "null" ? !present(value) : present(value)),
	like: (value, arg) => typeof value === "string" && likePattern(arg, "").test(value),
	lt: compare((value, threshold) => value < threshold),
	lte: compare((value, threshold) => value <= threshold),
	ne: negate,
	neq: negate,
	nin: (value, arg) => present(value) && !members(arg).includes(String(value)),
}

/** Why a filter cannot be applied as written. */
export type Refusal = "malformed" | "unknown" | "illegal" | "overIn" | "overCap" | "emptyIn"

/** A status to refuse with, `drop` to ignore the whole filter, or `apply` to evaluate it anyway. */
export type Policy = number | "drop" | "apply"

export interface Behavior {
	/** Operators that behave otherwise than `OPS`. */
	ops?: Partial<Record<string, OpImpl>>
	/** A closed operator list per field; an operator outside it is `illegal`. */
	closed?: Record<string, readonly string[]>
	maxIn?: number
	maxConditions?: number
	/** How each refusal is answered; by default a 400, and an empty in() is applied (matches none). */
	policy?: Partial<Record<Refusal, Policy>>
	/** and() and or() swapped. */
	swap?: boolean
	/** A nested group's combinator replaces the enclosing group's. */
	leak?: boolean
	/** Every page is the first page. */
	ignorePage?: boolean
	/** A status forced on a request, before anything else. */
	status?: (query: Record<string, unknown>, call: number) => number | undefined
}

type Node =
	| { kind: "term"; field: string; impl: OpImpl; arg: string }
	| { kind: "group"; comb: "and" | "or"; children: Node[] }

/** Splits on the commas outside any parentheses. */
function topLevel(text: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]
		if (ch === "(") depth += 1
		else if (ch === ")") depth -= 1
		else if (ch === "," && depth === 0) {
			parts.push(text.slice(start, i))
			start = i + 1
		}
	}
	parts.push(text.slice(start))
	return parts
}

interface Parsed {
	node: Node
	refusals: Refusal[]
	terms: number
}

/** A term as written, `field.op.arg`: the field, the operator's name, and its argument. */
interface TermParts {
	field: string
	name: string
	arg: string
}

function refusalsOf({ field, name, arg }: TermParts, behavior: Behavior): Refusal[] {
	const out: Refusal[] = []
	if (!(field in PROPERTIES) || (behavior.ops?.[name] ?? OPS[name]) === undefined) out.push("unknown")
	const closed = behavior.closed?.[field]
	if (closed !== undefined && !closed.includes(name)) out.push("illegal")
	const count = name === "in" || name === "nin" ? members(arg).length : -1
	if (count === 0) out.push("emptyIn")
	if (count > (behavior.maxIn ?? Number.POSITIVE_INFINITY)) out.push("overIn")
	return out
}

function parseTerm(text: string, behavior: Behavior, out: Parsed): Node | null {
	const match = /^([a-z_]+)\.([a-z]+)\.(.*)$/.exec(text)
	if (match === null) return null
	const [, field = "", name = "", arg = ""] = match
	out.refusals.push(...refusalsOf({ arg, field, name }, behavior))
	out.terms += 1
	return { arg, field, impl: behavior.ops?.[name] ?? OPS[name] ?? (() => true), kind: "term" }
}

function parseNode(text: string, behavior: Behavior, out: Parsed): Node | null {
	const group = /^(and|or)\((.*)\)$/s.exec(text)
	if (group === null) return parseTerm(text, behavior, out)
	const children = topLevel(group[2] ?? "").map((part) => parseNode(part, behavior, out))
	if (children.some((child) => child === null)) return null
	return { children: children as Node[], comb: group[1] as "and" | "or", kind: "group" }
}

function parse(text: string, behavior: Behavior): Parsed | "malformed" {
	const out: Parsed = { node: { children: [], comb: "and", kind: "group" }, refusals: [], terms: 0 }
	const node = parseNode(text, behavior, out)
	if (node === null) return "malformed"
	out.node = node
	if (behavior.maxConditions !== undefined && out.terms > behavior.maxConditions) out.refusals.push("overCap")
	return out
}

function evaluate(node: Node, row: Record_, behavior: Behavior): boolean {
	if (node.kind === "term") return node.impl(row[node.field], node.arg)
	let comb = node.comb
	if (behavior.swap === true) comb = comb === "and" ? "or" : "and"
	const nested = node.children.find((child) => child.kind === "group")
	if (behavior.leak === true && nested?.kind === "group") comb = nested.comb
	const results = node.children.map((child) => evaluate(child, row, behavior))
	return comb === "and" ? results.every(Boolean) : results.some(Boolean)
}

const DEFAULT_POLICY: Record<Refusal, Policy> = {
	emptyIn: "apply",
	illegal: 400,
	malformed: 400,
	overCap: 400,
	overIn: 400,
	unknown: 400,
}

function filtered(rows: Record_[], filter: string, behavior: Behavior): Record_[] | number {
	const parsed = parse(filter, behavior)
	const refusals: Refusal[] = parsed === "malformed" ? ["malformed"] : parsed.refusals
	for (const refusal of refusals) {
		const policy = behavior.policy?.[refusal] ?? DEFAULT_POLICY[refusal]
		if (typeof policy === "number") return policy
		if (policy === "drop") return rows
	}
	if (parsed === "malformed") return rows
	return rows.filter((row) => evaluate(parsed.node, row, behavior))
}

function paged(rows: Record_[], query: Record<string, unknown>, behavior: Behavior): Record_[] {
	const limit = Number(query.limit ?? 50)
	const page = behavior.ignorePage === true ? 1 : Number(query.page ?? 1)
	return rows.slice((page - 1) * limit, page * limit)
}

/** Answers the widget listing from `store` (or what it returns now), as `behavior` says. */
export function backend(store: Record_[] | ((call: number) => Record_[]), behavior: Behavior = {}): Responder {
	let call = 0
	return (method: string, path: string, options: Omit<RequestOptions, "as">): Answer | undefined => {
		call += 1
		if (method !== "GET" || path !== PATH) return undefined
		const query = (options.query ?? {}) as Record<string, unknown>
		const forced = behavior.status?.(query, call)
		if (forced !== undefined) return { body: { error: "forced" }, status: forced }
		const rows = typeof store === "function" ? store(call) : store
		const filter = query.filter
		const matched = typeof filter === "string" ? filtered(rows, filter, behavior) : rows
		if (typeof matched === "number") return { body: { error: "refused" }, status: matched }
		return { body: { widgets: paged(matched, query, behavior) }, status: 200 }
	}
}
