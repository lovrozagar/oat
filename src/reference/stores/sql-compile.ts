/**
 * Compiles the query AST to SQL for both SQL stores.
 *
 * One compiler, so SQLite and Postgres receive the same predicate. What differs is spelled by an
 * `SqlFlavour`: placeholders, how a value is cast to text, how a case-sensitive pattern match is
 * written, and which collation means "binary". Those are real engine differences; the meaning of
 * the predicate is not.
 */

import type { EntityDef } from "../model/types.ts"
import type { Collation, FilterNode, LikeSegment, OrderTerm, Scalar, SearchMode, SelectPlan } from "../query-types.ts"

export type SqlParam = string | number | boolean | null

/** A pattern to match: its segments, and whether case is ignored. */
export interface LikePattern {
	segments: LikeSegment[]
	insensitive: boolean
}

/** Text to look for, and whether case must match. */
export interface Needle {
	text: string
	caseSensitive: boolean
}

export interface SqlFlavour {
	/** The expression reading a field — a quoted column, or a deliberately wrong one under a defect. */
	column(entity: EntityDef, field: string): string
	/** Appends a bound argument and returns its placeholder. */
	bind(args: SqlParam[], value: SqlParam): string
	/** A boolean as the engine stores it. */
	bool(value: boolean): SqlParam
	toText(expr: string): string
	/** Text ordering under a binary collation. */
	binary(expr: string): string
	/** A case-sensitive or case-insensitive match of `expr` against the pattern. */
	like(expr: string, pattern: LikePattern, args: SqlParam[]): string
	/** Where the needle first occurs in `expr`, 1-based, or 0 — with the engine's own case folding. */
	position(expr: string, needle: Needle, args: SqlParam[]): string
	/** Whether a JSON array column holds `element` as one of its elements. */
	hasElement(expr: string, element: string, args: SqlParam[]): string
	random: string
}

function isText(entity: EntityDef, field: string): boolean {
	return entity.fields.find((f) => f.name === field)?.type === "string"
}

function value(flavour: SqlFlavour, scalar: Scalar, asText: boolean): SqlParam {
	if (asText) return String(scalar)
	if (typeof scalar === "boolean") return flavour.bool(scalar)
	return scalar
}

/** What every clause of one compilation shares: the entity read, the engine's spelling, the bound arguments. */
export interface Compilation {
	entity: EntityDef
	flavour: SqlFlavour
	args: SqlParam[]
}

type Node<K extends FilterNode["kind"]> = FilterNode & { kind: K }

export function compileWhere(node: FilterNode, compilation: Compilation): string {
	const { args, entity, flavour } = compilation
	switch (node.kind) {
		case "const":
			return node.value ? "1 = 1" : "1 = 0"
		case "and":
		case "or":
			return `(${node.children.map((child) => compileWhere(child, compilation)).join(node.kind === "and" ? " AND " : " OR ")})`
		case "isnull":
			return `${flavour.column(entity, node.field)} IS ${node.negate ? "NOT " : ""}NULL`
		case "cmp":
			return compileCmp(node, compilation)
		case "in":
			return compileIn(node, compilation)
		case "like":
			return flavour.like(
				flavour.column(entity, node.field),
				{ insensitive: node.insensitive, segments: node.pattern },
				args,
			)
		case "contains":
			return compileContains(node, compilation)
		case "search":
			return `(${node.fields
				.map((field) => searchClause(flavour.toText(flavour.column(entity, field)), node, compilation))
				.join(" OR ")})`
	}
}

function compileCmp(node: Node<"cmp">, { args, entity, flavour }: Compilation): string {
	const column = flavour.column(entity, node.field)
	/* Text compares binary, whatever the database default collation is. */
	const ref = node.asText ? flavour.toText(column) : isText(entity, node.field) ? flavour.binary(column) : column
	const op = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=", neq: "<>" }[node.op]
	const sql = `${ref} ${op} ${flavour.bind(args, value(flavour, node.value, node.asText))}`
	return node.nullsMatch ? `(${sql} OR ${column} IS NULL)` : sql
}

function compileIn(node: Node<"in">, { args, entity, flavour }: Compilation): string {
	const column = flavour.column(entity, node.field)
	if (node.values.length === 0) return node.negate ? "1 = 1" : "1 = 0"
	const ref = node.asText ? flavour.toText(column) : column
	const holes = node.values.map((member) => flavour.bind(args, value(flavour, member, node.asText))).join(", ")
	return node.negate ? `(${ref} NOT IN (${holes}) OR ${column} IS NULL)` : `${ref} IN (${holes})`
}

function compileContains(node: Node<"contains">, { args, entity, flavour }: Compilation): string {
	const column = flavour.column(entity, node.field)
	/* The defect matches the serialised array as text, so "red" also matches "redwood". */
	return node.substring
		? `${flavour.position(column, { caseSensitive: true, text: node.value }, args)} > 0`
		: flavour.hasElement(column, node.value, args)
}

function searchClause(
	expr: string,
	node: { token: string; mode: SearchMode; caseSensitive: boolean },
	{ args, flavour }: Compilation,
): string {
	const at = flavour.position(expr, { caseSensitive: node.caseSensitive, text: node.token }, args)
	return node.mode === "prefix" ? `${at} = 1` : `${at} > 0`
}

/** The ORDER BY clause for a plan's order, or "" when it has none. */
export function compileOrder(
	plan: Pick<SelectPlan, "collation" | "order" | "shuffleTies">,
	entity: EntityDef,
	flavour: SqlFlavour,
): string {
	const terms: string[] = []
	const ordering = { collation: plan.collation, entity, flavour }
	for (const term of plan.order) {
		const column = flavour.column(entity, term.field)
		/* Null placement is written out rather than left to the engine, because the engines
		 * disagree: SQLite sorts nulls first ascending, Postgres last. */
		terms.push(`${column} IS NULL ${term.nullsFirst ? "DESC" : "ASC"}`)
		terms.push(`${orderRef(term, column, ordering)} ${term.descending ? "DESC" : "ASC"}`)
	}
	if (plan.shuffleTies) terms.push(flavour.random)
	return terms.length === 0 ? "" : ` ORDER BY ${terms.join(", ")}`
}

/* What an ORDER BY is written for: the entity, the engine's spelling, and the plan's collation. */
interface Ordering extends Omit<Compilation, "args"> {
	collation: Collation
}

/* What one order term sorts by: its text form, its text under the collation, or the bare column. */
function orderRef(term: OrderTerm, column: string, { collation, entity, flavour }: Ordering): string {
	if (term.asText) return flavour.toText(column)
	if (!isText(entity, term.field)) return column
	return collation === "insensitive" ? `LOWER(${column})` : flavour.binary(column)
}

/** A LIKE pattern with `\` escaping, for engines whose LIKE honours ESCAPE. */
export function likeText(segments: LikeSegment[]): string {
	return segments
		.map((segment) =>
			segment.kind === "any" ? "%" : segment.kind === "one" ? "_" : segment.text.replace(/[\\%_]/g, (ch) => `\\${ch}`),
		)
		.join("")
}

/** A GLOB pattern — SQLite's case-sensitive matcher, which needs no pragma. */
export function globText(segments: LikeSegment[]): string {
	return segments
		.map((segment) =>
			segment.kind === "any" ? "*" : segment.kind === "one" ? "?" : segment.text.replace(/[*?[]/g, (ch) => `[${ch}]`),
		)
		.join("")
}
