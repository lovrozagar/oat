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
 *
 * Null semantics, decided once and held by every store:
 *   - `eq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `ilike` never match a null value.
 *   - `neq` and `nin` do match a null value: null is not equal to, and not a member of, anything.
 *   - `is.null` / `is.notnull` test for null explicitly. `eq.null` is not a null test: on a
 *     text field it compares against the text "null", as PostgREST does.
 */

import { DefectSet } from "./defects.ts"
import type { EntityDef, FieldDef } from "./model.ts"
import { OVERCLAIMED_FIELD, fieldsWhere } from "./model.ts"
import { SqlError } from "./store-api.ts"

export type Scalar = string | number | boolean | null

export type LikeSegment = { kind: "text"; text: string } | { kind: "any" } | { kind: "one" }

export type ComparisonOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte"

export type FilterNode =
	| { kind: "const"; value: boolean }
	| { kind: "and" | "or"; children: FilterNode[] }
	| {
			kind: "cmp"
			field: string
			op: ComparisonOp
			value: Scalar
			/** Compare the textual form of both sides — the numeric-as-text defect. */
			asText: boolean
			/** Whether a null value satisfies the predicate. True only for a correct `neq`. */
			nullsMatch: boolean
	  }
	| { kind: "in"; field: string; values: Scalar[]; negate: boolean; asText: boolean }
	| { kind: "isnull"; field: string; negate: boolean }
	| { kind: "like"; field: string; pattern: LikeSegment[]; insensitive: boolean }
	/** Array membership. `substring` is the defect: the serialised array matched as text. */
	| { kind: "contains"; field: string; value: string; substring: boolean }
	| {
			kind: "search"
			fields: string[]
			token: string
			/** `prefix`: some field starts with the token; `contains`: some field contains it. */
			mode: SearchMode
			caseSensitive: boolean
	  }

export interface OrderTerm {
	field: string
	descending: boolean
	nullsFirst: boolean
	asText: boolean
}

export type Collation = "binary" | "insensitive"

export const SEARCH_MODES = ["contains", "prefix"] as const
export type SearchMode = (typeof SEARCH_MODES)[number]

/** Everything a store needs to answer a listing: which rows, in what order. */
export interface SelectPlan {
	where: FilterNode
	order: OrderTerm[]
	/** Text ordering. Filters always compare binary; only ordering follows the collation. */
	collation: Collation
	/**
	 * Tied rows come back in an arbitrary, varying order — what a database does when the sort
	 * has no total order. Set only under UNSTABLE_SORT; otherwise the identity breaks every tie.
	 */
	shuffleTies: boolean
}

/** Behaviour of a correct backend that varies between real APIs — see `ReferenceShape`. */
export interface QueryConventions {
	/** Where nulls sort when the request does not say. */
	nulls: "first" | "last"
	collation: Collation
	/** Reject a filter value that does not parse as the field's type, instead of matching nothing. */
	strictTypes: boolean
}

export const DEFAULT_CONVENTIONS: QueryConventions = { collation: "binary", nulls: "first", strictTypes: false }

/* ------------------------------------------------------------------ parsing */

const OPERATORS = new Set(["eq", "ne", "neq", "gt", "gte", "lt", "lte", "in", "nin", "like", "ilike", "is", "contains"])

/** Splits on commas at paren depth zero — shared by the filter and order grammars. */
export function splitTopLevel(input: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]
		if (ch === "(") depth++
		else if (ch === ")") depth--
		else if (ch === "," && depth === 0) {
			parts.push(input.slice(start, i))
			start = i + 1
		}
	}
	parts.push(input.slice(start))
	return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

function stripParens(value: string): string {
	return value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value
}

function countTerms(expression: string): number {
	const group = /^(and|or)\((.*)\)$/s.exec(expression.trim())
	if (group?.[2] !== undefined) return splitTopLevel(group[2]).reduce((sum, part) => sum + countTerms(part), 0)
	return 1
}

function fieldOf(entity: EntityDef, name: string): FieldDef | undefined {
	return entity.fields.find((field) => field.name === name)
}

function filterableFields(entity: EntityDef, defects: DefectSet): string[] {
	const declared = fieldsWhere(entity, "filterable")
	/* Under the overclaim the backend refuses a field the document still declares filterable. The
	 * backend is not wrong to refuse — the document is wrong to promise. */
	return defects.has("SPEC_OVERCLAIMS_FILTERABLE") ? declared.filter((f) => f !== OVERCLAIMED_FIELD) : declared
}

function sortableFields(entity: EntityDef, defects: DefectSet): string[] {
	const declared = fieldsWhere(entity, "sortable")
	return defects.has("SPEC_OVERCLAIMS_SORTABLE") ? declared.filter((f) => f !== OVERCLAIMED_FIELD) : declared
}

function isNumeric(field: FieldDef | undefined): boolean {
	return field?.type === "integer" || field?.type === "number"
}

/**
 * The value a filter term compares against, read as the field's declared type.
 *
 * `undefined` means the text does not denote a value of that type at all. A lenient backend turns
 * that into a predicate matching nothing; a strict one rejects the request.
 */
function coerce(raw: string, field: FieldDef): Scalar | undefined {
	if (field.type === "integer" || field.type === "number") {
		if (raw.trim() === "") return undefined
		const n = Number(raw)
		if (!Number.isFinite(n)) return undefined
		if (field.type === "integer" && !Number.isInteger(n)) return undefined
		return n
	}
	if (field.type === "boolean") {
		if (raw === "true") return true
		if (raw === "false") return false
		return undefined
	}
	return raw
}

function likePattern(raw: string, unescaped: boolean): LikeSegment[] {
	const segments: LikeSegment[] = []
	let text = ""
	const flush = (): void => {
		if (text !== "") segments.push({ kind: "text", text })
		text = ""
	}
	for (const ch of raw) {
		/* `*` is the grammar's wildcard. `%` and `_` are literals — unless the backend interpolates
		 * the value into a LIKE pattern without escaping it, which is the LIKE_UNESCAPED defect. */
		if (ch === "*" || (unescaped && ch === "%")) {
			flush()
			segments.push({ kind: "any" })
		} else if (unescaped && ch === "_") {
			flush()
			segments.push({ kind: "one" })
		} else {
			text += ch
		}
	}
	flush()
	return segments
}

interface ParseContext {
	entity: EntityDef
	defects: DefectSet
	conventions: QueryConventions
}

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
	const { defects, entity } = ctx
	const trimmed = expression.trim()

	const group = /^(and|or)\((.*)\)$/s.exec(trimmed)
	if (group?.[1] !== undefined && group[2] !== undefined) {
		const children = splitTopLevel(group[2]).map((part) => parseNode(part, ctx))
		if (children.length === 0) throw new SqlError("invalid_filter", `empty ${group[1]}() group`)
		/* The joiner is swapped, not the parse: the expression is read correctly and evaluated with
		 * the other combinator's semantics. */
		const named = group[1] as "and" | "or"
		let kind: "and" | "or" = defects.has("FILTER_GROUP_COMBINATOR_SWAPPED") ? (named === "and" ? "or" : "and") : named
		/* One shared "current joiner": the last nested group to set it decides how this group joins. */
		if (defects.has("FILTER_NESTED_COMBINATOR_LEAKS")) {
			const nested = children.filter((child) => child.kind === "and" || child.kind === "or").at(-1)
			if (nested !== undefined && (nested.kind === "and" || nested.kind === "or")) kind = nested.kind
		}
		return { children, kind }
	}

	const segments = trimmed.split(".")
	if (segments.length < 3) throw new SqlError("invalid_filter", `malformed filter term "${trimmed}"`)
	const [name, rawOp] = segments as [string, string]
	const raw = segments.slice(2).join(".")

	if (!OPERATORS.has(rawOp)) {
		if (defects.has("FILTER_ILLEGAL_OP_IGNORED")) return { kind: "const", value: true }
		throw new SqlError("invalid_filter", `unknown operator "${rawOp}"`)
	}
	const aliases = entity.filterCatalog?.aliases
	const alias = aliases !== undefined && Object.hasOwn(aliases, rawOp) ? aliases[rawOp] : undefined
	/* The alias table maps `ne` to the wrong operator. */
	const mapped = alias !== undefined && defects.has("FILTER_ALIAS_MISMAPPED") ? "eq" : alias
	const op = mapped ?? (rawOp === "ne" ? "neq" : rawOp)
	const opsByField = entity.filterCatalog?.opsByField
	const allowed = opsByField !== undefined && Object.hasOwn(opsByField, name) ? opsByField[name] : undefined
	if (allowed !== undefined && !allowed.includes(rawOp) && !allowed.includes(op)) {
		if (defects.has("FILTER_ILLEGAL_OP_IGNORED")) return { kind: "const", value: true }
		throw new SqlError("invalid_filter", `operator "${rawOp}" is not allowed on "${name}"`)
	}
	/* The document lists `like` on `slug`; under the overclaim the backend no longer supports it. */
	if (defects.has("SPEC_OVERCLAIMS_FILTER_OP") && name === "slug" && op === "like") {
		throw new SqlError("invalid_filter", `operator "like" is not supported on "slug"`)
	}
	if (!filterableFields(entity, defects).includes(name)) {
		/* Correct behaviour is to reject. The defect drops the term instead — the single most
		 * common real-world filter bug, and invisible to schema validation. */
		if (defects.has("FILTER_IGNORED")) return { kind: "const", value: true }
		throw new SqlError("invalid_filter", `field "${name}" is not filterable`)
	}
	const field = fieldOf(entity, name) as FieldDef
	return buildTerm(field, op, raw, ctx)
}

function buildTerm(field: FieldDef, op: string, raw: string, ctx: ParseContext): FilterNode {
	const { defects, conventions } = ctx
	const asText = isNumeric(field) && defects.has("NUMERIC_COMPARED_AS_TEXT")
	/* A value that is not of the field's type: lenient backends match nothing, strict ones say so. */
	const typed = (text: string): Scalar | undefined => {
		const value = coerce(text, field)
		if (value === undefined && conventions.strictTypes) {
			throw new SqlError("invalid_filter", `"${text}" is not a valid ${field.type} for "${field.name}"`)
		}
		return value
	}
	const never: FilterNode = { kind: "const", value: false }

	/* An array is filtered by membership and by nothing else. */
	if (field.type === "array" || op === "contains") {
		if (field.type !== "array" || op !== "contains") {
			throw new SqlError("invalid_filter", `operator "${op}" is not supported on "${field.name}"`)
		}
		return { field: field.name, kind: "contains", substring: defects.has("CONTAINS_MATCHES_SUBSTRING"), value: raw }
	}

	switch (op) {
		case "eq": {
			if (defects.has("FILTER_EQ_NOT_APPLIED")) return { kind: "const", value: true }
			const value = typed(raw)
			return value === undefined ? never : { asText, field: field.name, kind: "cmp", nullsMatch: false, op, value }
		}
		case "neq": {
			const value = typed(raw)
			/* Three-valued logic leaking through: in SQL `col <> x` is NULL — not true — when col is
			 * NULL, so null rows silently vanish unless the query also tests `col IS NULL`. */
			const nullsMatch = !defects.has("NEQ_DROPS_NULLS")
			if (value === undefined) {
				/* Nothing equals a value of the wrong type, so everything — nulls included — differs. */
				return nullsMatch ? { kind: "const", value: true } : { field: field.name, kind: "isnull", negate: true }
			}
			return { asText, field: field.name, kind: "cmp", nullsMatch, op, value }
		}
		case "gt":
		case "gte":
		case "lt":
		case "lte": {
			const value = typed(raw)
			if (value === undefined) return never
			const effective =
				op === "gte" && defects.has("FILTER_GTE_IS_GT")
					? "gt"
					: op === "lte" && defects.has("FILTER_LTE_IS_LT")
						? "lt"
						: op === "lt" && defects.has("FILTER_LT_IS_LTE")
							? "lte"
							: op
			return { asText, field: field.name, kind: "cmp", nullsMatch: false, op: effective, value }
		}
		case "in":
		case "nin": {
			const members = stripParens(raw)
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
			if (members.length === 0) {
				if (ctx.entity.filterCatalog?.emptyIn === "reject") throw new SqlError("invalid_filter", "empty in()")
				return { kind: "const", value: op === "nin" }
			}
			const max = ctx.entity.filterCatalog?.maxInValues
			if (max !== undefined && members.length > max && !defects.has("FILTER_IN_CAP_IGNORED")) {
				throw new SqlError("invalid_filter", `in() exceeds maxInValues=${max}`)
			}
			const values = members.map(typed).filter((value): value is Scalar => value !== undefined)
			const firstOnly =
				(defects.has("FILTER_IN_FIRST_ONLY") && op === "in") || (defects.has("FILTER_NIN_FIRST_ONLY") && op === "nin")
			const effective = firstOnly ? values.slice(0, 1) : values
			return { asText, field: field.name, kind: "in", negate: op === "nin", values: effective }
		}
		case "is": {
			if (raw === "null") {
				if (defects.has("FILTER_IS_NULL_MATCHES_ALL")) return { kind: "const", value: true }
				return { field: field.name, kind: "isnull", negate: false }
			}
			if (raw === "notnull" || raw === "not.null") return { field: field.name, kind: "isnull", negate: true }
			if ((raw === "true" || raw === "false") && field.type === "boolean") {
				return { asText: false, field: field.name, kind: "cmp", nullsMatch: false, op: "eq", value: raw === "true" }
			}
			throw new SqlError("invalid_filter", `is.${raw} is not a recognised predicate`)
		}
		case "like":
		case "ilike": {
			if (field.type !== "string") throw new SqlError("invalid_filter", `${op} needs a text field`)
			return {
				field: field.name,
				insensitive: op === "ilike" && !defects.has("FILTER_ILIKE_IS_LIKE"),
				kind: "like",
				pattern: likePattern(raw, defects.has("LIKE_UNESCAPED")),
			}
		}
		default:
			throw new SqlError("invalid_filter", `unhandled operator "${op}"`)
	}
}

/**
 * Parses a canonical order expression (`field.desc.nullslast,other`).
 *
 * `trusted` is for the server's own default order: it is not a request, so the request's
 * validation — and the defects that corrupt it — do not apply to it.
 */
export function parseOrder(expression: string, ctx: ParseContext, trusted = false): OrderTerm[] {
	const { entity, conventions } = ctx
	const defects = trusted ? new DefectSet() : ctx.defects
	const sortable = trusted ? fieldsWhere(entity, "sortable") : sortableFields(entity, defects)
	const terms = splitTopLevel(expression).flatMap((term): OrderTerm[] => {
		const [name, ...parsed] = term.split(".")
		if (name === undefined || !sortable.includes(name)) {
			/* Correct is to reject; the defect drops a term naming a field that does not exist. */
			const exists = entity.fields.some((field) => field.name === name)
			if (defects.has("SORT_UNKNOWN_FIELD_IGNORED") && !exists) return []
			throw new SqlError("invalid_order", `field "${name ?? ""}" is not sortable`)
		}
		const modifiers = defects.has("SORT_NULLS_MODIFIER_IGNORED")
			? parsed.filter((modifier) => modifier !== "nullsfirst" && modifier !== "nullslast")
			: parsed
		for (const modifier of modifiers) {
			if (!["asc", "desc", "nullsfirst", "nullslast"].includes(modifier)) {
				throw new SqlError("invalid_order", `unknown sort modifier "${modifier}"`)
			}
		}
		const descending = modifiers.includes("desc")
		/* The default placement is stated for ascending order; descending reverses it, so a
		 * descending sort is exactly the ascending one read backwards. */
		const defaultFirst = conventions.nulls === "first" ? !descending : descending
		const numeric = isNumeric(fieldOf(entity, name))
		return [
			{
				asText: numeric && (defects.has("SORT_NUMERIC_AS_TEXT") || defects.has("NUMERIC_COMPARED_AS_TEXT")),
				descending,
				field: name,
				nullsFirst: modifiers.includes("nullsfirst") ? true : modifiers.includes("nullslast") ? false : defaultFirst,
			},
		]
	})
	return defects.has("SORT_MULTI_KEY_IGNORED") ? terms.slice(0, 1) : terms
}

/**
 * Search tokens: every token must occur, case-insensitively, in some searchable field — as a
 * substring under `contains`, at the start of the value under `prefix`. A blank query matches
 * everything.
 */
export function parseSearch(q: string, entity: EntityDef, defects: DefectSet, mode: SearchMode): FilterNode | null {
	const split = q
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0)
	const fields = fieldsWhere(entity, "searchable")
	if (split.length === 0) return defects.has("SEARCH_EMPTY_MATCHES_NONE") ? { kind: "const", value: false } : null
	if (fields.length === 0) return null
	const tokens = defects.has("SEARCH_ONLY_FIRST_TOKEN") ? split.slice(0, 1) : split
	const caseSensitive = defects.has("SEARCH_CASE_SENSITIVE")
	return {
		children: tokens.map((token) => ({ caseSensitive, fields, kind: "search", mode, token })),
		kind: "and",
	}
}

export function and(...nodes: Array<FilterNode | null>): FilterNode {
	const children = nodes.filter((node): node is FilterNode => node !== null)
	if (children.length === 0) return { kind: "const", value: true }
	if (children.length === 1) return children[0] as FilterNode
	return { children, kind: "and" }
}

/** Fields a filter expression names, for the tombstone rule (an explicit mention lifts it). */
export function fieldsIn(node: FilterNode): string[] {
	switch (node.kind) {
		case "and":
		case "or":
			return node.children.flatMap(fieldsIn)
		case "const":
			return []
		case "search":
			return node.fields
		default:
			return [node.field]
	}
}

/* ----------------------------------------------------------------- evaluation */

type Row = Record<string, unknown>

function isNull(value: unknown): boolean {
	return value === null || value === undefined
}

function compareScalar(a: unknown, b: unknown, asText: boolean): number {
	if (!asText && typeof a === "number" && typeof b === "number") return a - b
	if (!asText && typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
	const as = String(a)
	const bs = String(b)
	return as < bs ? -1 : as > bs ? 1 : 0
}

function equal(a: unknown, b: Scalar, asText: boolean): boolean {
	if (asText) return String(a) === String(b)
	return a === b
}

export function likeToRegExp(pattern: LikeSegment[], insensitive: boolean): RegExp {
	const source = pattern
		.map((segment) =>
			segment.kind === "any"
				? "[\\s\\S]*"
				: segment.kind === "one"
					? "[\\s\\S]"
					: segment.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		)
		.join("")
	return new RegExp(`^${source}$`, insensitive ? "iu" : "u")
}

/** The in-memory evaluation of a filter — the reference semantics the SQL compilers match. */
export function evaluate(node: FilterNode, row: Row): boolean {
	switch (node.kind) {
		case "const":
			return node.value
		case "and":
			return node.children.every((child) => evaluate(child, row))
		case "or":
			return node.children.some((child) => evaluate(child, row))
		case "isnull":
			return isNull(row[node.field]) !== node.negate
		case "cmp": {
			const value = row[node.field]
			if (isNull(value)) return node.nullsMatch
			if (node.op === "eq") return equal(value, node.value, node.asText)
			if (node.op === "neq") return !equal(value, node.value, node.asText)
			const delta = compareScalar(value, node.value, node.asText)
			if (node.op === "gt") return delta > 0
			if (node.op === "gte") return delta >= 0
			if (node.op === "lt") return delta < 0
			return delta <= 0
		}
		case "in": {
			const value = row[node.field]
			if (isNull(value)) return node.negate
			const hit = node.values.some((member) => equal(value, member, node.asText))
			return hit !== node.negate
		}
		case "like": {
			const value = row[node.field]
			return typeof value === "string" && likeToRegExp(node.pattern, node.insensitive).test(value)
		}
		case "contains": {
			const value = row[node.field]
			if (!Array.isArray(value)) return false
			return node.substring
				? value.some((element) => String(element).includes(node.value))
				: value.some((element) => String(element) === node.value)
		}
		case "search": {
			const fold = (text: string): string => (node.caseSensitive ? text : text.toLowerCase())
			const needle = fold(node.token)
			return node.fields.some((field) => {
				const value = row[field]
				if (isNull(value)) return false
				const text = fold(String(value))
				return node.mode === "prefix" ? text.startsWith(needle) : text.includes(needle)
			})
		}
	}
}

/** Orders rows under the plan. Ties the plan leaves open keep their input order. */
export function compareRows(order: OrderTerm[], collation: Collation): (left: Row, right: Row) => number {
	return (left, right) => {
		for (const term of order) {
			const a = left[term.field]
			const b = right[term.field]
			const aNull = isNull(a)
			const bNull = isNull(b)
			if (aNull && bNull) continue
			if (aNull || bNull) return aNull === term.nullsFirst ? -1 : 1
			const delta =
				collation === "insensitive" && typeof a === "string" && typeof b === "string"
					? compareScalar(a.toLowerCase(), b.toLowerCase(), true)
					: compareScalar(a, b, term.asText)
			if (delta !== 0) return term.descending ? -delta : delta
		}
		return 0
	}
}
