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
	/** A case-sensitive or case-insensitive pattern match against `segments`. */
	like(expr: string, segments: LikeSegment[], insensitive: boolean, args: SqlParam[]): string
	/** Where `needle` first occurs in `expr`, 1-based, or 0 — with the engine's own case folding. */
	position(expr: string, needle: string, caseSensitive: boolean, args: SqlParam[]): string
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

/* What every clause of one compilation shares: the entity read, the engine's spelling, the bound arguments. */
interface Scope {
	entity: EntityDef
	flavour: SqlFlavour
	args: SqlParam[]
}

type Node<K extends FilterNode["kind"]> = FilterNode & { kind: K }

export function compileWhere(node: FilterNode, entity: EntityDef, flavour: SqlFlavour, args: SqlParam[]): string {
	const scope = { args, entity, flavour }
	switch (node.kind) {
		case "const":
			return node.value ? "1 = 1" : "1 = 0"
		case "and":
		case "or":
			return `(${node.children.map((child) => compileWhere(child, entity, flavour, args)).join(node.kind === "and" ? " AND " : " OR ")})`
		case "isnull":
			return `${flavour.column(entity, node.field)} IS ${node.negate ? "NOT " : ""}NULL`
		case "cmp":
			return compileCmp(node, scope)
		case "in":
			return compileIn(node, scope)
		case "like":
			return flavour.like(flavour.column(entity, node.field), node.pattern, node.insensitive, args)
		case "contains":
			return compileContains(node, scope)
		case "search":
			return `(${node.fields
				.map((field) => searchClause(flavour, flavour.toText(flavour.column(entity, field)), node, args))
				.join(" OR ")})`
	}
}

function compileCmp(node: Node<"cmp">, { args, entity, flavour }: Scope): string {
	const column = flavour.column(entity, node.field)
	/* Text compares binary, whatever the database default collation is. */
	const ref = node.asText ? flavour.toText(column) : isText(entity, node.field) ? flavour.binary(column) : column
	const op = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=", neq: "<>" }[node.op]
	const sql = `${ref} ${op} ${flavour.bind(args, value(flavour, node.value, node.asText))}`
	return node.nullsMatch ? `(${sql} OR ${column} IS NULL)` : sql
}

function compileIn(node: Node<"in">, { args, entity, flavour }: Scope): string {
	const column = flavour.column(entity, node.field)
	if (node.values.length === 0) return node.negate ? "1 = 1" : "1 = 0"
	const ref = node.asText ? flavour.toText(column) : column
	const holes = node.values.map((member) => flavour.bind(args, value(flavour, member, node.asText))).join(", ")
	return node.negate ? `(${ref} NOT IN (${holes}) OR ${column} IS NULL)` : `${ref} IN (${holes})`
}

function compileContains(node: Node<"contains">, { args, entity, flavour }: Scope): string {
	const column = flavour.column(entity, node.field)
	/* The defect matches the serialised array as text, so "red" also matches "redwood". */
	return node.substring
		? `${flavour.position(column, node.value, true, args)} > 0`
		: flavour.hasElement(column, node.value, args)
}

function searchClause(
	flavour: SqlFlavour,
	expr: string,
	node: { token: string; mode: SearchMode; caseSensitive: boolean },
	args: SqlParam[],
): string {
	const at = flavour.position(expr, node.token, node.caseSensitive, args)
	return node.mode === "prefix" ? `${at} = 1` : `${at} > 0`
}

/** The ORDER BY clause for a plan's order, or "" when it has none. */
export function compileOrder(
	plan: Pick<SelectPlan, "collation" | "order" | "shuffleTies">,
	entity: EntityDef,
	flavour: SqlFlavour,
): string {
	const terms: string[] = []
	for (const term of plan.order) {
		const column = flavour.column(entity, term.field)
		/* Null placement is written out rather than left to the engine, because the engines
		 * disagree: SQLite sorts nulls first ascending, Postgres last. */
		terms.push(`${column} IS NULL ${term.nullsFirst ? "DESC" : "ASC"}`)
		terms.push(`${orderRef(term, column, plan.collation, { entity, flavour })} ${term.descending ? "DESC" : "ASC"}`)
	}
	if (plan.shuffleTies) terms.push(flavour.random)
	return terms.length === 0 ? "" : ` ORDER BY ${terms.join(", ")}`
}

/* What one order term sorts by: its text form, its text under the collation, or the bare column. */
function orderRef(
	term: OrderTerm,
	column: string,
	collation: Collation,
	{ entity, flavour }: Omit<Scope, "args">,
): string {
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
