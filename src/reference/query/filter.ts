/**
 * The reference backend's query language, parsed once.
 *
 * Filter, sort, select and search arrive as text in the canonical grammar (`field.op.value`,
 * `and(...)`, `field.desc`). They are parsed here into an AST that every store consumes: the
 * in-memory store evaluates it, the SQL stores compile it. Defects that change what a predicate
 * *means* are applied here as rewrites of the tree, so a defect is defined exactly once and every
 * engine exhibits the same bug.
 *
 * Values are coerced by the field's declared type, never by what the text looks like. A string
 * field filtered on `123` compares against the string "123"; a numeric field filtered on `abc`
 * matches nothing (or is rejected with a 400 when the backend is strictly typed).
 */

import type { FieldDef } from "../model/types.ts"
import type { FilterNode } from "../query-types.ts"
import { SqlError } from "../store-api.ts"
import type { ParseContext } from "./conventions.ts"
import { fieldOf, filterableFields } from "./fields.ts"
import { operatorFor } from "./operator.ts"
import { countTerms, GROUP, splitTopLevel } from "./split.ts"
import { buildTerm } from "./term.ts"

type Group = Extract<FilterNode, { kind: "and" | "or" }>

/** Parses a canonical filter expression. Throws `SqlError` for anything a correct backend rejects. */
export function parseFilter(expression: string, ctx: ParseContext): FilterNode {
	const catalog = ctx.entity.filterCatalog
	if (
		catalog?.maxFilterConditions !== undefined &&
		countTerms(expression) > catalog.maxFilterConditions &&
		!ctx.defects.has("FILTER_CONDITION_CAP_IGNORED")
	) {
		throw new SqlError("invalid_filter", `more than ${catalog.maxFilterConditions} filter conditions`)
	}
	return parseNode(expression, ctx)
}

function parseNode(expression: string, ctx: ParseContext): FilterNode {
	const trimmed = expression.trim()
	const group = GROUP.exec(trimmed)
	if (group !== null) return parseGroup(group[1] as Group["kind"], group[2] as string, ctx)
	return parseTerm(trimmed, ctx)
}

function parseGroup(named: Group["kind"], inner: string, ctx: ParseContext): FilterNode {
	const { defects } = ctx
	const children = splitTopLevel(inner).map((part) => parseNode(part, ctx))
	if (children.length === 0) throw new SqlError("invalid_filter", `empty ${named}() group`)
	/* The joiner is swapped, not the parse: the expression is read correctly and evaluated with
	 * the other combinator's semantics. */
	let kind: Group["kind"] = defects.has("FILTER_GROUP_COMBINATOR_SWAPPED") ? (named === "and" ? "or" : "and") : named
	/* One shared "current joiner": the last nested group to set it decides how this group joins. */
	if (defects.has("FILTER_NESTED_COMBINATOR_LEAKS")) {
		const nested = children.filter((child): child is Group => child.kind === "and" || child.kind === "or").at(-1)
		if (nested !== undefined) kind = nested.kind
	}
	return { children, kind }
}

function parseTerm(trimmed: string, ctx: ParseContext): FilterNode {
	const { defects, entity } = ctx
	const segments = trimmed.split(".")
	if (segments.length < 3) {
		if (defects.has("IGNORES_MALFORMED_FILTER")) return { kind: "const", value: true }
		throw new SqlError("invalid_filter", `malformed filter term "${trimmed}"`)
	}
	const [name, rawOp] = segments as [string, string]
	const raw = segments.slice(2).join(".")
	const op = operatorFor(name, rawOp, ctx)
	if (op === null) return { kind: "const", value: true }
	if (!filterableFields(entity, defects).includes(name)) {
		/* Correct behaviour is to reject. The defect drops the term instead — the single most
		 * common real-world filter bug, and invisible to schema validation. */
		if (defects.has("FILTER_IGNORED")) return { kind: "const", value: true }
		throw new SqlError("invalid_filter", `field "${name}" is not filterable`)
	}
	const field = fieldOf(entity, name) as FieldDef
	return buildTerm({ ctx, field, op, raw })
}
