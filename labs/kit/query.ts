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

export function compileFilter(
	expression: string,
	filterable: readonly string[],
	columns: ReadonlySet<string>,
	numeric: ReadonlySet<string>,
	opts: CompileFilterOptions = {},
): Compiled {
	return compileNode(expression.trim(), filterable, columns, numeric, opts)
}

function compileNode(
	input: string,
	filterable: readonly string[],
	columns: ReadonlySet<string>,
	numeric: ReadonlySet<string>,
	opts: CompileFilterOptions,
): Compiled {
	const and = /^and\((.*)\)$/s.exec(input)
	if (and?.[1] !== undefined) {
		const op = opts.andAsOr === true ? "OR" : "AND"
		return join(splitTop(and[1]).map((p) => compileNode(p, filterable, columns, numeric, opts)), op)
	}
	const or = /^or\((.*)\)$/s.exec(input)
	if (or?.[1] !== undefined) {
		const op = opts.orAsAnd === true ? "AND" : "OR"
		return join(splitTop(or[1]).map((p) => compileNode(p, filterable, columns, numeric, opts)), op)
	}
	const match = /^([a-z_]+)\.([a-z]+)\.(.*)$/s.exec(input)
	if (match === null) throw new QueryError(`malformed filter: ${input}`)
	const field = match[1] as string
	const op = match[2] as string
	const raw = match[3] as string
	if (!OPS.has(op)) throw new QueryError(`unknown filter operator: ${op}`)
	if (!columns.has(field) || !filterable.includes(field)) {
		if (opts.acceptUnknown === true) return { args: [], sql: "1 = 1" }
		throw new QueryError(`unknown filter field: ${field}`)
	}
	return compare(field, op, raw, numeric, opts)
}

function compare(
	field: string,
	op: string,
	raw: string,
	numeric: ReadonlySet<string>,
	opts: CompileFilterOptions,
): Compiled {
	const ident = `"${field}"`
	const value = coerce(field, raw, numeric)
	if (op === "eq") return { args: [value], sql: `${ident} = ?` }
	if (op === "neq") {
		if (opts.ignoreNeq === true) return { args: [], sql: "1 = 1" }
		return { args: [value], sql: `(${ident} IS NULL OR ${ident} <> ?)` }
	}
	if (opts.textCompare === true && numeric.has(field) && (op === "gt" || op === "gte" || op === "lt" || op === "lte")) {
		const cmp = op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<="
		return { args: [String(raw)], sql: `CAST(${ident} AS TEXT) ${cmp} ?` }
	}
	if (op === "gt") return { args: [value], sql: `${ident} > ?` }
	if (op === "gte") return { args: [value], sql: `${ident} >= ?` }
	if (op === "lt") return { args: [value], sql: `${ident} < ?` }
	if (op === "lte") return { args: [value], sql: `${ident} <= ?` }
	if (op === "like" || op === "ilike") {
		if (opts.unescapeLike === true) {
			const pattern = String(raw).replaceAll("*", "%")
			const sql = op === "ilike" ? `LOWER(${ident}) LIKE LOWER(?)` : `${ident} LIKE ?`
			return { args: [pattern], sql }
		}
		const escaped = String(raw).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
			.replaceAll("*", "%")
		const sql = op === "ilike"
			? `LOWER(${ident}) LIKE LOWER(?) ESCAPE '\\'`
			: `${ident} LIKE ? ESCAPE '\\'`
		return { args: [escaped], sql }
	}
	throw new QueryError(`unknown filter operator: ${op}`)
}

export function compileOrder(
	expression: string,
	sortable: readonly string[],
	columns: ReadonlySet<string>,
	tiebreak: string,
): Compiled {
	const terms: string[] = []
	for (const raw of expression.split(",").map((t) => t.trim()).filter(Boolean)) {
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
	selectable: readonly string[],
	columns: ReadonlySet<string>,
): Record<string, unknown> {
	if (select === undefined || select === "" || select === "*") return { ...row }
	const out: Record<string, unknown> = {}
	for (const field of select.split(",").map((s) => s.trim()).filter(Boolean)) {
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
	constructor(message: string) {
		super(message)
	}
}
