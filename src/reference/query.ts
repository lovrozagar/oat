/**
 * PostgREST-shaped query engine for the reference backend.
 *
 * Deliberately simple and readable — its job is to be *obviously* correct so that any finding
 * oat reports against the clean baseline is oat's fault, not the reference's. Defects are
 * applied as explicit, local deviations rather than woven into the logic.
 */

import type { DefectSet } from "./defects.ts"
import { SqlError } from "./store-api.ts"

/* One error type across every store, so the HTTP layer has a single thing to catch. Two
 * separate classes meant a rejected filter surfaced as 400 on the SQL stores and 500 here — the
 * conformance suite reported it as a defect, correctly. */
export { SqlError as QueryError } from "./store-api.ts"

export type Row = Record<string, unknown>

export interface QueryParams {
	filter?: string | undefined
	order?: string | undefined
	select?: string | undefined
	q?: string | undefined
	limit?: number | undefined
	page?: number | undefined
	cursor?: string | undefined
}

export interface QueryOptions {
	searchable: readonly string[]
	filterable: readonly string[]
	sortable: readonly string[]
	identity: string
	softDeleteField?: string
	defaultLimit: number
	maxLimit: number
}

export interface QueryResult {
	items: Row[]
	count: number
	hasMore: boolean
	nextCursor: string | null
	page: number | null
	limit: number
}

/* ------------------------------------------------------------------ filter AST */

type Predicate = (row: Row) => boolean

const COMPARATORS = new Set([
	"eq",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"nin",
	"like",
	"ilike",
	"is",
	"contains",
])

/** Splits on commas that sit at paren depth zero. */
function splitTopLevel(input: string): string[] {
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

function parseFilter(expression: string, options: QueryOptions, defects: DefectSet): Predicate {
	const trimmed = expression.trim()

	const group = /^(and|or)\((.*)\)$/s.exec(trimmed)
	if (group?.[1] && group[2] !== undefined) {
		const combinator = group[1]
		const children = splitTopLevel(group[2]).map((part) => parseFilter(part, options, defects))
		if (children.length === 0) {
			throw new SqlError("invalid_filter", `empty ${combinator}() group`)
		}
		return combinator === "and"
			? (row) => children.every((child) => child(row))
			: (row) => children.some((child) => child(row))
	}

	const segments = trimmed.split(".")
	if (segments.length < 3) {
		throw new SqlError("invalid_filter", `malformed filter term "${trimmed}"`)
	}
	const [field, op] = segments as [string, string, ...string[]]
	const rawValue = segments.slice(2).join(".")

	if (!COMPARATORS.has(op)) {
		throw new SqlError("invalid_filter", `unknown operator "${op}"`)
	}
	if (!options.filterable.includes(field)) {
		/* Correct behaviour is to reject. The defect drops the term instead — the single most
		 * common real-world filter bug, and invisible to schema validation. */
		if (defects.has("FILTER_IGNORED")) return () => true
		throw new SqlError("invalid_filter", `field "${field}" is not filterable`)
	}

	return buildComparator(field, op, rawValue, defects)
}

function buildComparator(
	field: string,
	op: string,
	rawValue: string,
	defects: DefectSet,
): Predicate {
	const value = coerce(rawValue)

	switch (op) {
		case "eq":
			if (defects.has("FILTER_EQ_NOT_APPLIED")) return () => true
			return (row) => looseEqual(row[field], value)
		case "neq":
			/* Three-valued logic leaking through: in SQL, `col <> x` is NULL — not true — when col
			 * is NULL, so those rows silently vanish unless the query says `OR col IS NULL`. */
			if (defects.has("NEQ_DROPS_NULLS")) {
				return (row) =>
					row[field] !== null && row[field] !== undefined && !looseEqual(row[field], value)
			}
			return (row) => !looseEqual(row[field], value)
		case "gt":
			return (row) => compare(row[field], value) > 0
		case "gte":
			return (row) => compare(row[field], value) >= 0
		case "lt":
			return (row) => compare(row[field], value) < 0
		case "lte":
			return (row) => compare(row[field], value) <= 0
		case "in":
		case "nin": {
			const members = stripParens(rawValue).split(",").map((s) => coerce(s.trim()))
			return (row) => {
				const hit = members.some((member) => looseEqual(row[field], member))
				return op === "in" ? hit : !hit
			}
		}
		case "is": {
			if (rawValue === "null") return (row) => row[field] === null || row[field] === undefined
			if (rawValue === "true") return (row) => row[field] === true
			if (rawValue === "false") return (row) => row[field] === false
			throw new SqlError("invalid_filter", `is.${rawValue} is not a recognised predicate`)
		}
		case "contains":
			return (row) => Array.isArray(row[field]) && row[field].some((v) => looseEqual(v, value))
		case "like":
		case "ilike": {
			const pattern = likeToRegExp(rawValue, op === "ilike", defects)
			return (row) => typeof row[field] === "string" && pattern.test(row[field])
		}
		default:
			throw new SqlError("invalid_filter", `unhandled operator "${op}"`)
	}
}

/**
 * `*` is the wildcard. Everything else — notably `%` and `_`, which users type constantly —
 * must be escaped so it matches literally. Forgetting to is a real bug class: a value
 * containing `%` then matches every row.
 */
function likeToRegExp(pattern: string, insensitive: boolean, defects: DefectSet): RegExp {
	const escaped = defects.has("LIKE_UNESCAPED")
		? pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/[%_]/g, ".*")
		: pattern.replace(/[.+^${}()|[\]\\%_]/g, "\\$&")
	return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, insensitive ? "i" : "")
}

function stripParens(value: string): string {
	return value.startsWith("(") && value.endsWith(")") ? value.slice(1, -1) : value
}

function coerce(raw: string): unknown {
	if (raw === "null") return null
	if (raw === "true") return true
	if (raw === "false") return false
	if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw)
	return raw
}

function looseEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a === null || a === undefined || b === null || b === undefined) return false
	return String(a) === String(b)
}

function compare(a: unknown, b: unknown): number {
	if (a === null || a === undefined) return -1
	if (b === null || b === undefined) return 1
	if (typeof a === "number" && typeof b === "number") return a - b
	const as = String(a)
	const bs = String(b)
	return as < bs ? -1 : as > bs ? 1 : 0
}

/* ------------------------------------------------------------------- ordering */

interface SortTerm {
	field: string
	descending: boolean
	nullsFirst: boolean
}

function parseOrder(expression: string, options: QueryOptions): SortTerm[] {
	return splitTopLevel(expression).map((term) => {
		const [field, ...modifiers] = term.split(".")
		if (field === undefined || !options.sortable.includes(field)) {
			throw new SqlError("invalid_order", `field "${field ?? ""}" is not sortable`)
		}
		const descending = modifiers.includes("desc")
		return {
			descending,
			field,
			/* Postgres default: NULLs sort last ascending, first descending. */
			nullsFirst: modifiers.includes("nullsfirst")
				? true
				: modifiers.includes("nullslast")
					? false
					: descending,
		}
	})
}

/** Advances per query so tied rows land differently each time — see UNSTABLE_SORT below. */
let unstableRotation = 0

function applyOrder(
	rows: Row[],
	terms: SortTerm[],
	options: QueryOptions,
	defects: DefectSet,
): Row[] {
	/* A sort without a total order is not a sort — equal keys may come back in any order, and
	 * keyset pagination built on it silently loses rows. The tiebreak is what makes paging sound.
	 *
	 * Array.prototype.sort is stable, so simply dropping the tiebreak would still yield a
	 * deterministic order and the defect would be unobservable. A real database without a
	 * tiebreak returns tied rows in whatever order the plan produced, varying between queries —
	 * so the defect rotates the input to reproduce that. */
	const effective = defects.has("UNSTABLE_SORT")
		? terms
		: [...terms, { descending: false, field: options.identity, nullsFirst: false }]

	let input = [...rows]
	if (defects.has("UNSTABLE_SORT") && input.length > 1) {
		unstableRotation = (unstableRotation + 1) % input.length
		input = [...input.slice(unstableRotation), ...input.slice(0, unstableRotation)]
	}

	return input.sort((left, right) => {
		for (const term of effective) {
			const a = left[term.field]
			const b = right[term.field]
			const aNull = a === null || a === undefined
			const bNull = b === null || b === undefined
			if (aNull && bNull) continue
			if (aNull || bNull) {
				const nullRank = aNull ? -1 : 1
				return term.nullsFirst ? nullRank : -nullRank
			}
			const delta = compare(a, b)
			if (delta !== 0) return term.descending ? -delta : delta
		}
		return 0
	})
}

/* ------------------------------------------------------------------ execution */

export function runQuery(
	source: readonly Row[],
	params: QueryParams,
	options: QueryOptions,
	defects: DefectSet,
	/** Applied before the sparse fieldset, so a derived value cannot reintroduce a deselected
	 * column. Mirrors the SQL stores so every backend projects identically. */
	transform?: ((row: Row) => Row) | undefined,
): QueryResult {
	let rows = [...source]

	if (options.softDeleteField !== undefined && !defects.has("SOFT_DELETE_LEAK")) {
		const field = options.softDeleteField
		const mentionsTombstones = params.filter?.includes(field) === true
		if (!mentionsTombstones) rows = rows.filter((row) => row[field] === null || row[field] === undefined)
	}

	const unfilteredCount = rows.length

	if (params.filter !== undefined && params.filter !== "") {
		let predicate: Predicate
		try {
			predicate = parseFilter(params.filter, options, defects)
		} catch (error) {
			/* Correct behaviour is a 400. The defect lets the parser's own exception escape,
			 * which the transport surfaces as a 500 — validation confused with crashing. */
			if (defects.has("ERROR_500_ON_BAD_FILTER")) {
				throw new Error(`unhandled filter parse failure: ${String(error)}`)
			}
			throw error
		}
		const filtered = rows.filter(predicate)
		/* The "no results must mean the query was wrong" guard — falls back to the unfiltered set
		 * and makes an empty result impossible to express. */
		rows = defects.has("EMPTY_RESULT_RETURNS_ALL") && filtered.length === 0 ? rows : filtered
	}

	if (params.q !== undefined && params.q !== "" && !defects.has("SEARCH_IGNORED")) {
		const needle = params.q.toLowerCase()
		rows = rows.filter((row) =>
			options.searchable.some((field) => String(row[field] ?? "").toLowerCase().includes(needle)),
		)
	}

	const terms = params.order === undefined || params.order === ""
		? []
		: parseOrder(params.order, options)
	if (defects.has("SORT_DESC_DROPS_NULLS")) {
		for (const term of terms) {
			if (!term.descending) continue
			rows = rows.filter((row) => row[term.field] !== null && row[term.field] !== undefined)
		}
	}
	rows = applyOrder(rows, defects.has("ORDER_IGNORED") ? [] : terms, options, defects)

	const requestedLimit = params.limit ?? options.defaultLimit
	const limit = defects.has("LIMIT_EXCEEDS_MAX")
		? requestedLimit
		: Math.min(requestedLimit, options.maxLimit)
	const total = defects.has("COUNT_ALWAYS_ZERO")
		? 0
		: defects.has("COUNT_IGNORES_FILTER")
			? unfilteredCount
			: rows.length

	let offset: number
	let page: number | null
	if (params.cursor !== undefined && params.cursor !== "") {
		const afterId = decodeCursor(params.cursor)
		const index = rows.findIndex((row) => String(row[options.identity]) === afterId)
		/* Under CURSOR_DRIFT the cursor resolves one row early, so the cursor walk and the
		 * offset walk disagree — each looks self-consistent in isolation. */
		offset = index === -1 ? 0 : index + (defects.has("CURSOR_DRIFT") ? 0 : 1)
		page = null
	} else {
		const requested = Math.max(params.page ?? 1, 1)
		offset = (requested - 1) * limit + (defects.has("OFF_BY_ONE_PAGE") && requested > 1 ? 1 : 0)
		page = requested
	}

	/* LIMIT_IGNORED serves the whole set regardless of the requested page size — the caller's
	 * paging loop then appears to complete in one request. */
	const window = defects.has("LIMIT_IGNORED")
		? rows.slice(offset)
		: rows.slice(offset, offset + limit)
	const last = window.at(-1)
	const hasMore = defects.has("HASMORE_ALWAYS_FALSE")
		? false
		: offset + window.length < rows.length

	const projected = window
		.map((row) => (transform === undefined ? row : transform(row)))
		.map((row) => project(row, params.select, defects))

	return {
		count: total,
		hasMore,
		items: projected,
		limit,
		nextCursor: hasMore && last !== undefined ? encodeCursor(String(last[options.identity])) : null,
		page,
	}
}

function project(row: Row, select: string | undefined, defects: DefectSet): Row {
	if (select === undefined || select === "" || select === "*") return { ...row }
	if (defects.has("SELECT_IGNORED")) return { ...row }
	const fields = select.split(",").map((s) => s.trim()).filter(Boolean)
	const out: Row = {}
	for (const field of fields) {
		if (Object.hasOwn(row, field)) out[field] = row[field]
	}
	return out
}

export function encodeCursor(id: string): string {
	return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url")
}

export function decodeCursor(cursor: string): string {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: string }
		if (typeof parsed.id !== "string") throw new Error("missing id")
		return parsed.id
	} catch {
		throw new SqlError("invalid_cursor", "cursor is not a value produced by this API")
	}
}
