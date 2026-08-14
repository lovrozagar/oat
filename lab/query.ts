/**
 * PostgREST-shaped filter / order / select, compiled to SQL.
 *
 * Kept obviously correct: oat is the thing under test. A quiet run against this lab is
 * only meaningful if a dropped filter here is a real backend bug, not a parser quirk.
 */

export interface Compiled {
	sql: string
	args: Array<string | number | null>
}

const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike"])

const COLUMNS = new Set([
	"id",
	"org_id",
	"article_id",
	"author",
	"kind",
	"title",
	"slug",
	"status",
	"body",
	"position",
	"comment_count",
	"created_at",
	"updated_at",
	"deleted_at",
])

export function compileFilter(expression: string, filterable: readonly string[]): Compiled {
	return compileNode(expression.trim(), filterable)
}

function compileNode(input: string, filterable: readonly string[]): Compiled {
	const and = /^and\((.*)\)$/s.exec(input)
	if (and?.[1] !== undefined) return join(splitTop(and[1]).map((p) => compileNode(p, filterable)), "AND")
	const or = /^or\((.*)\)$/s.exec(input)
	if (or?.[1] !== undefined) return join(splitTop(or[1]).map((p) => compileNode(p, filterable)), "OR")

	const match = /^([a-z_]+)\.([a-z]+)\.(.*)$/s.exec(input)
	if (match === null) throw new QueryError(`malformed filter: ${input}`)
	const field = match[1] as string
	const op = match[2] as string
	const raw = match[3] as string
	if (!OPS.has(op)) throw new QueryError(`unknown filter operator: ${op}`)
	if (!COLUMNS.has(field) || !filterable.includes(field)) {
		throw new QueryError(`unknown filter field: ${field}`)
	}
	return compare(field, op, raw)
}

function compare(field: string, op: string, raw: string): Compiled {
	const ident = `"${field}"`
	if (op === "eq") return { args: [coerce(field, raw)], sql: `${ident} = ?` }
	if (op === "neq") {
		/* Include NULLs so a negation still partitions the set. SQL's `<>` would drop them. */
		return { args: [coerce(field, raw)], sql: `(${ident} IS NULL OR ${ident} <> ?)` }
	}
	if (op === "gt") return { args: [coerce(field, raw)], sql: `${ident} > ?` }
	if (op === "gte") return { args: [coerce(field, raw)], sql: `${ident} >= ?` }
	if (op === "lt") return { args: [coerce(field, raw)], sql: `${ident} < ?` }
	if (op === "lte") return { args: [coerce(field, raw)], sql: `${ident} <= ?` }
	if (op === "like" || op === "ilike") {
		/* Value is a literal. `*` is the grammar's wildcard; `%` and `_` must not expand. */
		const escaped = raw.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
			.replaceAll("*", "%")
		const sql = op === "ilike"
			? `LOWER(${ident}) LIKE LOWER(?) ESCAPE '\\'`
			: `${ident} LIKE ? ESCAPE '\\'`
		return { args: [escaped], sql }
	}
	throw new QueryError(`unknown filter operator: ${op}`)
}

export function compileOrder(expression: string, sortable: readonly string[], tiebreak: string): Compiled {
	const terms: string[] = []
	for (const raw of expression.split(",").map((t) => t.trim()).filter(Boolean)) {
		const [field, dir] = raw.includes(".") ? raw.split(".", 2) : [raw, "asc"]
		if (field === undefined || !COLUMNS.has(field) || !sortable.includes(field)) {
			throw new QueryError(`unknown sort field: ${field ?? raw}`)
		}
		const direction = dir === "desc" ? "DESC" : "ASC"
		/* NULLs last in both directions so a reversal is a membership-preserving reorder. */
		terms.push(`"${field}" ${direction} NULLS LAST`)
	}
	if (terms.length === 0) terms.push(`"${tiebreak}" ASC`)
	else if (!expression.split(",").some((t) => t.trim().startsWith(tiebreak))) {
		terms.push(`"${tiebreak}" ASC`)
	}
	return { args: [], sql: terms.join(", ") }
}

export function project(row: Record<string, unknown>, select: string | undefined, selectable: readonly string[]): Record<string, unknown> {
	if (select === undefined || select === "" || select === "*") return { ...row }
	const out: Record<string, unknown> = {}
	for (const field of select.split(",").map((s) => s.trim()).filter(Boolean)) {
		if (!selectable.includes(field) || !COLUMNS.has(field)) {
			throw new QueryError(`field "${field}" is not selectable`)
		}
		if (Object.hasOwn(row, field)) out[field] = row[field]
	}
	return out
}

function coerce(field: string, raw: string): string | number | null {
	if (raw === "null") return null
	if (
		field === "position"
		|| field === "comment_count"
		|| field === "created_at"
		|| field === "updated_at"
		|| field === "deleted_at"
	) {
		const n = Number(raw)
		if (!Number.isFinite(n)) throw new QueryError(`"${field}" must be numeric`)
		return n
	}
	return raw
}

function splitTop(input: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]
		if (ch === "(") depth += 1
		else if (ch === ")") depth -= 1
		else if (ch === "," && depth === 0) {
			parts.push(input.slice(start, i).trim())
			start = i + 1
		}
	}
	parts.push(input.slice(start).trim())
	return parts.filter(Boolean)
}

function join(parts: Compiled[], op: "AND" | "OR"): Compiled {
	if (parts.length === 0) throw new QueryError("empty filter group")
	return {
		args: parts.flatMap((p) => p.args),
		sql: `(${parts.map((p) => p.sql).join(` ${op} `)})`,
	}
}

export class QueryError extends Error {
	status = 400
	constructor(message: string) {
		super(message)
	}
}
