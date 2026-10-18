export interface Compiled {
	sql: string
	args: Array<string | number | null>
}

const OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike"])

export interface CompileFilterOptions {
	/** Treat `%` / `_` in the value as SQL wildcards instead of literals. */
	unescapeLike?: boolean
	acceptUnknown?: boolean
	ignoreNeq?: boolean
	andAsOr?: boolean
	orAsAnd?: boolean
	textCompare?: boolean
}

/** The columns a list may filter on, and which of them hold numbers. */
export interface FilterScope {
	filterable: readonly string[]
	columns: ReadonlySet<string>
	numeric: ReadonlySet<string>
}

interface Term {
	field: string
	op: string
	raw: string
}

/** A pattern term: its operator and the raw pattern it matches. */
interface LikeTerm {
	op: "like" | "ilike"
	raw: string
}

/** The fields an order may sort on, the row's columns, and the column that breaks ties. */
export interface OrderScope {
	sortable: readonly string[]
	columns: ReadonlySet<string>
	tiebreak: string
}

/** The fields a select may name, and the row's columns. */
export interface SelectScope {
	selectable: readonly string[]
	columns: ReadonlySet<string>
}

const COMPARISONS: Readonly<Record<string, string>> = /* @__PURE__ */ Object.freeze({
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
})

export function compileFilter(expression: string, scope: FilterScope, opts: CompileFilterOptions = {}): Compiled {
	return compileNode(expression.trim(), scope, opts)
}

function compileNode(input: string, scope: FilterScope, opts: CompileFilterOptions): Compiled {
	const and = /^and\((.*)\)$/s.exec(input)
	if (and?.[1] !== undefined) {
		const op = opts.andAsOr === true ? "OR" : "AND"
		return join(
			splitTop(and[1]).map((p) => compileNode(p, scope, opts)),
			op,
		)
	}
	const or = /^or\((.*)\)$/s.exec(input)
	if (or?.[1] !== undefined) {
		const op = opts.orAsAnd === true ? "AND" : "OR"
		return join(
			splitTop(or[1]).map((p) => compileNode(p, scope, opts)),
			op,
		)
	}
	return compileTerm(input, scope, opts)
}

function compileTerm(input: string, scope: FilterScope, opts: CompileFilterOptions): Compiled {
	const match = /^([a-z_]+)\.([a-z]+)\.(.*)$/s.exec(input)
	if (match === null) throw new QueryError(`malformed filter: ${input}`)
	const term: Term = { field: match[1] as string, op: match[2] as string, raw: match[3] as string }
	if (!OPS.has(term.op)) throw new QueryError(`unknown filter operator: ${term.op}`)
	if (!scope.columns.has(term.field) || !scope.filterable.includes(term.field)) {
		if (opts.acceptUnknown === true) return { args: [], sql: "1 = 1" }
		throw new QueryError(`unknown filter field: ${term.field}`)
	}
	return compare(term, scope.numeric, opts)
}

function compare(term: Term, numeric: ReadonlySet<string>, opts: CompileFilterOptions): Compiled {
	const { field, op, raw } = term
	const ident = `"${field}"`
	const value = coerce(field, raw, numeric)
	if (op === "eq") return { args: [value], sql: `${ident} = ?` }
	if (op === "neq") {
		if (opts.ignoreNeq === true) return { args: [], sql: "1 = 1" }
		return { args: [value], sql: `(${ident} IS NULL OR ${ident} <> ?)` }
	}
	const cmp = COMPARISONS[op]
	if (cmp !== undefined) {
		if (opts.textCompare === true && numeric.has(field)) {
			return { args: [String(raw)], sql: `CAST(${ident} AS TEXT) ${cmp} ?` }
		}
		return { args: [value], sql: `${ident} ${cmp} ?` }
	}
	if (op === "like" || op === "ilike") return like(ident, { op, raw }, opts)
	throw new QueryError(`unknown filter operator: ${op}`)
}

function like(ident: string, { op, raw }: LikeTerm, opts: CompileFilterOptions): Compiled {
	if (opts.unescapeLike === true) {
		const pattern = String(raw).replaceAll("*", "%")
		const sql = op === "ilike" ? `LOWER(${ident}) LIKE LOWER(?)` : `${ident} LIKE ?`
		return { args: [pattern], sql }
	}
	const escaped = String(raw)
		.replaceAll("\\", "\\\\")
		.replaceAll("%", "\\%")
		.replaceAll("_", "\\_")
		.replaceAll("*", "%")
	const sql = op === "ilike" ? `LOWER(${ident}) LIKE LOWER(?) ESCAPE '\\'` : `${ident} LIKE ? ESCAPE '\\'`
	return { args: [escaped], sql }
}

export function compileOrder(expression: string, { columns, sortable, tiebreak }: OrderScope): Compiled {
	const terms: string[] = []
	for (const raw of expression
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean)) {
		const [field, dir] = raw.includes(".") ? raw.split(".", 2) : [raw, "asc"]
		if (field === undefined || !columns.has(field) || !sortable.includes(field)) {
			throw new QueryError(`unknown sort field: ${field ?? raw}`)
		}
		const direction = dir === "desc" ? "DESC" : "ASC"
		terms.push(`"${field}" ${direction} NULLS LAST`)
	}
	if (terms.length === 0) terms.push(`"${tiebreak}" ASC`)
	else if (!expression.split(",").some((t) => t.trim().startsWith(tiebreak))) {
		terms.push(`"${tiebreak}" ASC`)
	}
	return { args: [], sql: terms.join(", ") }
}

export function project(
	row: Record<string, unknown>,
	select: string | undefined,
	{ columns, selectable }: SelectScope,
): Record<string, unknown> {
	if (select === undefined || select === "" || select === "*") return { ...row }
	const out: Record<string, unknown> = {}
	for (const field of select
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)) {
		if (!selectable.includes(field) || !columns.has(field)) {
			throw new QueryError(`field "${field}" is not selectable`)
		}
		if (Object.hasOwn(row, field)) out[field] = row[field]
	}
	return out
}

function coerce(field: string, raw: string, numeric: ReadonlySet<string>): string | number | null {
	if (raw === "null") return null
	if (numeric.has(field)) {
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
}
