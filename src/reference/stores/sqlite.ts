/**
 * SQLite-backed storage for the reference backend.
 *
 * The in-memory store executes the query grammar in JavaScript, which quietly sidesteps the
 * behaviours that break real APIs: NULL ordering, collation, LIKE escaping, type affinity, and
 * result order when a sort has no total order. Those are exactly the semantics oat's checks
 * reason about, so a reference backend that never touches SQL can only prove so much.
 *
 * The engine is supplied as a driver, so the same SQL runs in-process via `node:sqlite` and
 * remotely against Cloudflare D1. That second target is not redundancy: D1 is a different build
 * with different compile flags, reached over the network, backed by a database that persists
 * between runs — three properties an in-process store cannot exhibit.
 */

import type { DefectSet } from "../defects.ts"
import type { EntityDef, FieldDef } from "../model.ts"
import { ENTITIES, OVERCLAIMED_FIELD, fieldsWhere } from "../model.ts"
import {
	decodeCursor,
	encodeCursor,
	project,
	type QueryOptions,
	type QueryParams,
	type QueryResult,
	type Row,
	SqlError,
	splitTopLevel,
	stripParens,
	type Store,
} from "../store-api.ts"
import type { SqliteDriver, SqlValue } from "./sqlite-driver.ts"

export { SqlError }
export type { QueryParams, QueryResult, Row }

function countTerms(expression: string): number {
	const group = /^(and|or)\((.*)\)$/s.exec(expression.trim())
	if (group?.[2] !== undefined) {
		return splitTopLevel(group[2]).reduce((sum, part) => sum + countTerms(part), 0)
	}
	return 1
}

/** SQLite storage class per declared field type. */
const AFFINITY: Record<FieldDef["type"], string> = {
	boolean: "INTEGER",
	integer: "INTEGER",
	number: "REAL",
	string: "TEXT",
}

/**
 * Physical column name.
 *
 * Deliberately the declared field name, quoted. A production API this was modelled on named
 * columns one way in DDL and another way in every read, and SQLite's double-quoted-string
 * fallback turned the mismatch into wrong data instead of an error — see the
 * COLUMN_NAME_MISMATCH defect, which reproduces it.
 */
function col(name: string): string {
	return `"${name.replace(/"/g, '""')}"`
}

/**
 * Physical table name.
 *
 * Prefixed per store instance because a remote database outlives the process that created it:
 * two runs sharing one D1 would otherwise collide on both schema and data, and the resulting
 * cross-talk would surface as findings that describe the harness rather than the backend.
 */
function tableName(entity: EntityDef, prefix: string): string {
	return `"${prefix}${entity.plural}"`
}

export class SqlStore implements Store {
	private sequence = 0

	private constructor(
		private readonly defects: DefectSet,
		private readonly db: SqliteDriver,
		private readonly prefix: string,
	) {}

	/**
	 * Schema creation is a set of round trips on a networked engine, so it cannot live in a
	 * constructor. `prefix` isolates one run's tables from another's on a shared database.
	 */
	static async create(defects: DefectSet, driver: SqliteDriver, prefix = ""): Promise<SqlStore> {
		const store = new SqlStore(defects, driver, prefix)
		/* One statement per table would be one network round trip per table. Both drivers accept
		 * a multi-statement script, so the whole schema costs a single trip. */
		await driver.exec(ENTITIES.map((entity) => store.ddl(entity)).join(";\n"))
		return store
	}

	async close(): Promise<void> {
		/* Persistent engines keep whatever this run created unless it is dropped. Failures here
		 * are swallowed: teardown must not mask the result the run was there to produce. */
		if (this.prefix !== "") {
			for (const entity of ENTITIES) {
				try {
					await this.db.exec(`DROP TABLE IF EXISTS ${tableName(entity, this.prefix)}`)
				} catch {
					/* ignore */
				}
			}
		}
		await this.db.close()
	}

	private ddl(entity: EntityDef): string {
		const columns = entity.fields.map((field) => {
			const physical = this.physical(field.name)
			const notNull = field.required === true ? " NOT NULL" : ""
			return `  ${physical} ${AFFINITY[field.type]}${notNull}`
		})
		const table = tableName(entity, this.prefix)
		return (
			`CREATE TABLE ${table} (\n${columns.join(",\n")}\n);\n` +
			`CREATE INDEX "${this.prefix}idx_${entity.plural}_id" ON ${table} (${col(entity.identity)})`
		)
	}

	nextId(prefix: string): string {
		this.sequence += 1
		return `${prefix}_${String(this.sequence).padStart(6, "0")}`
	}

	now(): number {
		/* Monotonic and derived from the sequence: wall-clock timestamps make ordering
		 * assertions flaky for reasons that have nothing to do with the backend. */
		return 1_700_000_000_000 + this.sequence * 1000
	}

	/** The stored column for a field — diverges from the declared name only under the defect. */
	private physical(name: string): string {
		return this.defects.has("COLUMN_NAME_MISMATCH") && name === "name" ? col("mislabelled_name") : col(name)
	}

	async insert(entity: EntityDef, record: Row): Promise<Row> {
		const names = entity.fields.map((f) => f.name).filter((n) => record[n] !== undefined)
		const placeholders = names.map(() => "?").join(", ")
		const columns = names.map((n) => this.physical(n)).join(", ")
		const values = names.map((n) => toSql(record[n]))
		/* RETURNING reads the stored row back in the same statement. On a networked engine the
		 * separate SELECT this replaces doubled the cost of every write. */
		const written = await this.db.all(
			`INSERT INTO ${tableName(entity, this.prefix)} (${columns}) VALUES (${placeholders}) ` +
				`RETURNING ${this.selectList(entity)}`,
			values,
		)
		const row = written[0]
		return row === undefined ? record : this.decode(entity, row)
	}

	/**
	 * Explicit column list, as production code writes it.
	 *
	 * `SELECT *` would paper over a DDL/read naming mismatch; naming columns is what lets
	 * SQLite's double-quoted-string fallback surface — an unresolvable "name" silently becomes
	 * the literal 'name' rather than an error. See COLUMN_NAME_MISMATCH.
	 */
	private selectList(entity: EntityDef): string {
		return entity.fields
			.map((f) => {
				if (!this.defects.has("COLUMN_NAME_MISMATCH") || f.name !== "name") return col(f.name)
				/*
				 * The bug is that DDL wrote `mislabelled_name` while reads ask for `name`.
				 *
				 * On an engine with double-quoted-string fallback ON, that is expressible in its
				 * natural form — `"name"` resolves to no column, so SQLite hands back the literal
				 * 'name' and the API serves the column's own name as every row's value. Writing
				 * it that way means the *engine* produces the damage, which is a materially
				 * stronger test than asserting oat catches a hand-written imitation.
				 *
				 * Where the fallback is compiled off the same SQL is an error, not a silent wrong
				 * answer, so the damaging outcome is emitted directly instead.
				 */
				return this.db.dqs ? col(f.name) : `'${f.name}' AS ${col(f.name)}`
			})
			.join(", ")
	}

	async byId(entity: EntityDef, id: string): Promise<Row | null> {
		const rows = await this.db.all(
			`SELECT ${this.selectList(entity)} FROM ${tableName(entity, this.prefix)} WHERE ${col(entity.identity)} = ?`,
			[id],
		)
		const row = rows[0]
		return row === undefined ? null : this.decode(entity, row)
	}

	async update(entity: EntityDef, id: string, patch: Row): Promise<Row | null> {
		if (this.defects.has("CONCURRENT_WRITE_LOST")) return this.readModifyWrite(entity, id, patch)
		const names = Object.keys(patch).filter((n) => entity.fields.some((f) => f.name === n))
		if (names.length === 0) return this.byId(entity, id)
		const assignments = names.map((n) => `${this.physical(n)} = ?`).join(", ")
		const written = await this.db.all(
			`UPDATE ${tableName(entity, this.prefix)} SET ${assignments} ` +
				`WHERE ${col(entity.identity)} = ? RETURNING ${this.selectList(entity)}`,
			[...names.map((n) => toSql(patch[n])), id],
		)
		const row = written[0]
		return row === undefined ? null : this.decode(entity, row)
	}

	/**
	 * Reads the row, yields, then writes every column back — the `save(entity)` pattern.
	 *
	 * A synchronous driver does not prevent this: the lost update comes from the *handler*
	 * holding state across an await, not from engine-level locking, so it reproduces here
	 * exactly as it does on a networked database.
	 */
	private async readModifyWrite(entity: EntityDef, id: string, patch: Row): Promise<Row | null> {
		const current = await this.byId(entity, id)
		if (current === null) return null
		await new Promise((resolve) => setTimeout(resolve, 15))
		const merged = { ...current, ...patch }
		const names = entity.fields.map((f) => f.name)
		const assignments = names.map((n) => `${this.physical(n)} = ?`).join(", ")
		await this.db.run(`UPDATE ${tableName(entity, this.prefix)} SET ${assignments} WHERE ${col(entity.identity)} = ?`, [
			...names.map((n) => toSql(merged[n])),
			id,
		])
		return this.byId(entity, id)
	}

	async remove(entity: EntityDef, id: string): Promise<void> {
		await this.db.run(`DELETE FROM ${tableName(entity, this.prefix)} WHERE ${col(entity.identity)} = ?`, [id])
	}

	/**
	 * Converts stored values back to their declared shape. SQLite has no boolean type, so a
	 * field declared boolean comes back as 0/1 and would fail its own response schema.
	 */
	private decode(entity: EntityDef, row: Row): Row {
		const out: Row = {}
		for (const field of entity.fields) {
			const raw = row[field.name]
			if (raw === undefined || raw === null) {
				out[field.name] = null
				continue
			}
			out[field.name] = field.type === "boolean" ? raw === 1 : raw
		}
		return out
	}

	/* ------------------------------------------------------------------ querying */

	async query(
		entity: EntityDef,
		scope: Record<string, string>,
		params: QueryParams,
		options: QueryOptions,
	): Promise<QueryResult> {
		const where: string[] = []
		const args: SqlValue[] = []

		/* Ancestor scoping — `.../tables/{table_id}/rows` lists that table only. The defect
		 * applies scoping to the plain listing but drops it once a filter is present, which is
		 * how a filter turns into an authorization bypass. */
		const scoped = !(this.defects.has("TENANT_LEAK_VIA_FILTER") && params.filter !== undefined)
		for (const parent of scoped ? entity.parents : []) {
			const value = scope[parent]
			if (value === undefined) continue
			if (!entity.fields.some((f) => f.name === parent)) continue
			where.push(`${col(parent)} = ?`)
			args.push(value)
		}

		const soft = options.softDeleteField
		if (soft !== undefined && !this.defects.has("SOFT_DELETE_LEAK")) {
			const mentioned = params.filter?.includes(soft) === true
			if (!mentioned) where.push(`${col(soft)} IS NULL`)
		}

		if (params.filter !== undefined && params.filter !== "") {
			const compiled = this.compileFilter(params.filter, entity)
			where.push(compiled.sql)
			args.push(...compiled.args)
		}

		if (params.q !== undefined && params.q !== "" && !this.defects.has("SEARCH_IGNORED")) {
			const searchable = fieldsWhere(entity, "searchable")
			const tokens = params.q
				.split(/\s+/)
				.map((token) => token.trim())
				.filter((token) => token.length > 0)
			if (searchable.length > 0) {
				for (const token of tokens) {
					const clauses = searchable.map((f) => `${col(f)} LIKE ? ESCAPE '\\'`)
					where.push(`(${clauses.join(" OR ")})`)
					for (const _ of searchable) args.push(`%${escapeLike(token)}%`)
				}
			}
		}

		const orderSql = this.compileOrder(params.order, entity)
		if (this.dropNullsFor !== null) where.push(`${col(this.dropNullsFor)} IS NOT NULL`)
		const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""

		const countWhere = this.defects.has("COUNT_IGNORES_FILTER") ? "" : whereSql
		const countArgs = this.defects.has("COUNT_IGNORES_FILTER") ? [] : args
		const counted = await this.db.all(
			`SELECT COUNT(*) AS n FROM ${tableName(entity, this.prefix)}${countWhere}`,
			countArgs,
		)
		const total = { n: Number(counted[0]?.n ?? 0) }

		const requested = params.limit ?? entity.defaultLimit
		const limit = this.defects.has("LIMIT_EXCEEDS_MAX") ? requested : Math.min(requested, entity.maxLimit)

		let offset: number
		let page: number | null
		if (params.cursor !== undefined && params.cursor !== "") {
			const afterId = decodeCursor(params.cursor)
			/* The cursor boundary must be resolved under exactly the listing's ordering. Under the
			 * defect it uses NOCASE while the listing uses BINARY, so the index found here is not
			 * the index the listing would have produced and the page boundary lands elsewhere. */
			/* NOCASE against the listing's BINARY: with mixed-case data the two disagree, because
			 * BINARY sorts every uppercase letter before every lowercase one. */
			const cursorOrderSql = this.defects.has("COLLATION_INCONSISTENT")
				? orderSql.replace(/(".*?")( (?:ASC|DESC))/g, "$1 COLLATE NOCASE$2")
				: orderSql
			const ordered = (await this.db.all(
				`SELECT ${col(entity.identity)} AS id FROM ${tableName(entity, this.prefix)}${whereSql}${cursorOrderSql}`,
				args,
			)) as Array<{ id: string }>
			const index = ordered.findIndex((r) => String(r.id) === afterId)
			offset = index === -1 ? 0 : index + (this.defects.has("CURSOR_DRIFT") ? 0 : 1)
			page = null
		} else {
			const requestedPage = Math.max(params.page ?? 1, 1)
			offset = (requestedPage - 1) * limit + (this.defects.has("OFF_BY_ONE_PAGE") && requestedPage > 1 ? 1 : 0)
			page = requestedPage
		}

		const window = this.defects.has("LIMIT_IGNORED") ? -1 : limit
		const rows = await this.db.all(
			`SELECT ${this.selectList(entity)} FROM ${tableName(entity, this.prefix)}${whereSql}${orderSql} LIMIT ? OFFSET ?`,
			[...args, window, offset],
		)

		/* The "no results must mean a bad query" guard — falls back to the unfiltered set and
		 * makes an empty result impossible to express. */
		const effective =
			this.defects.has("EMPTY_RESULT_RETURNS_ALL") && rows.length === 0 && where.length > 0
				? await this.db.all(
						`SELECT ${this.selectList(entity)} FROM ${tableName(entity, this.prefix)}${orderSql} LIMIT ? OFFSET ?`,
						[window, offset],
					)
				: rows

		const decoded = effective.map((row) => this.decode(entity, row))
		const last = decoded.at(-1)
		const hasMore = this.defects.has("HASMORE_ALWAYS_FALSE") ? false : offset + decoded.length < total.n

		return {
			count: this.defects.has("COUNT_ALWAYS_ZERO") ? 0 : total.n,
			hasMore,
			items: decoded
				.map((row) => (options.transform === undefined ? row : options.transform(row)))
				.map((row) =>
					project(
						row,
						params.select,
						this.defects.has("SELECT_IGNORED"),
						this.defects.has("SPEC_OVERCLAIMS_SELECTABLE") ? [OVERCLAIMED_FIELD] : [],
						{
							dropRequested: this.defects.has("SELECT_FIELD_MISSING"),
							identity: entity.identity,
							...(entity.filterCatalog?.selectUnknown === undefined
								? {}
								: { selectUnknown: entity.filterCatalog.selectUnknown }),
						},
					),
				),
			limit,
			nextCursor: hasMore && last !== undefined ? encodeCursor(String(last[entity.identity])) : null,
			page,
		}
	}

	/* ------------------------------------------------------------- filter → SQL */

	private compileFilter(expression: string, entity: EntityDef, top = true): { sql: string; args: SqlValue[] } {
		if (top && entity.filterCatalog?.maxFilterConditions !== undefined) {
			const count = countTerms(expression)
			if (count > entity.filterCatalog.maxFilterConditions) {
				throw new SqlError("invalid_filter", `more than ${entity.filterCatalog.maxFilterConditions} filter conditions`)
			}
		}
		const trimmed = expression.trim()

		const group = /^(and|or)\((.*)\)$/s.exec(trimmed)
		if (group?.[1] && group[2] !== undefined) {
			const parts = splitTopLevel(group[2]).map((part) => this.compileFilter(part, entity, false))
			if (parts.length === 0) throw new SqlError("invalid_filter", "empty filter group")
			const effective = this.defects.has("FILTER_GROUP_COMBINATOR_SWAPPED")
				? group[1] === "and"
					? "or"
					: "and"
				: group[1]
			return {
				args: parts.flatMap((p) => p.args),
				sql: `(${parts.map((p) => p.sql).join(effective === "and" ? " AND " : " OR ")})`,
			}
		}

		const segments = trimmed.split(".")
		if (segments.length < 3) {
			throw new SqlError("invalid_filter", `malformed filter term "${trimmed}"`)
		}
		const [field, rawOp] = segments as [string, string, ...string[]]
		const op = rawOp === "ne" ? "neq" : rawOp
		const raw = segments.slice(2).join(".")
		const allowed = entity.filterCatalog?.opsByField?.[field]
		if (allowed !== undefined && rawOp !== undefined && !allowed.includes(rawOp) && !allowed.includes(op)) {
			if (this.defects.has("FILTER_ILLEGAL_OP_IGNORED")) return { args: [], sql: "1 = 1" }
			throw new SqlError("invalid_filter", `unknown operator "${rawOp}"`)
		}

		/* Under the overclaim defect the backend refuses a field the document still declares
		 * filterable — the backend is not wrong to refuse, the document is wrong to promise. */
		const filterable = this.defects.has("SPEC_OVERCLAIMS_FILTERABLE")
			? fieldsWhere(entity, "filterable").filter((f) => f !== OVERCLAIMED_FIELD)
			: fieldsWhere(entity, "filterable")
		if (!filterable.includes(field)) {
			if (this.defects.has("FILTER_IGNORED")) return { args: [], sql: "1 = 1" }
			throw new SqlError("invalid_filter", `field "${field}" is not filterable`)
		}

		const declared = entity.fields.find((f) => f.name === field)
		const numeric = declared?.type === "integer" || declared?.type === "number"
		/* SQLite compares by storage class, so a numeric column normally orders numerically.
		 * Casting to TEXT is what reproduces `amount > 9` missing 10. */
		const ref = numeric && this.defects.has("NUMERIC_COMPARED_AS_TEXT") ? `CAST(${col(field)} AS TEXT)` : col(field)
		const asText = !numeric || this.defects.has("NUMERIC_COMPARED_AS_TEXT")
		switch (op) {
			case "eq":
				if (this.defects.has("FILTER_EQ_NOT_APPLIED")) return { args: [], sql: "1 = 1" }
				return { args: [coerce(raw, asText)], sql: `${ref} = ?` }
			case "neq":
				/* Correct negation must re-admit NULLs: in SQL `col <> x` is NULL — not true — for
				 * NULL rows, so they silently vanish without the explicit IS NULL branch. The
				 * defect drops that branch, which is the real-world bug this models. */
				return this.defects.has("NEQ_DROPS_NULLS")
					? { args: [coerce(raw)], sql: `${ref} <> ?` }
					: { args: [coerce(raw)], sql: `(${ref} <> ? OR ${ref} IS NULL)` }
			case "gt":
				return { args: [coerce(raw, asText)], sql: `${ref} > ?` }
			case "gte":
				if (this.defects.has("FILTER_GTE_IS_GT")) return { args: [coerce(raw, asText)], sql: `${ref} > ?` }
				return { args: [coerce(raw, asText)], sql: `${ref} >= ?` }
			case "lt":
				return { args: [coerce(raw, asText)], sql: `${ref} < ?` }
			case "lte":
				return { args: [coerce(raw, asText)], sql: `${ref} <= ?` }
			case "in":
			case "nin": {
				const members: SqlValue[] = stripParens(raw)
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0)
					.map((s) => coerce(s))
				if (members.length === 0) {
					if (entity.filterCatalog?.emptyIn === "reject") throw new SqlError("invalid_filter", "empty in()")
					return { args: [], sql: op === "in" ? "1 = 0" : "1 = 1" }
				}
				if (entity.filterCatalog?.maxInValues !== undefined && members.length > entity.filterCatalog.maxInValues) {
					throw new SqlError("invalid_filter", "in() exceeds maxInValues")
				}
				const effective =
					this.defects.has("FILTER_IN_FIRST_ONLY") && op === "in" && members[0] !== undefined ? [members[0]] : members
				const holes = effective.map(() => "?").join(", ")
				return {
					args: effective,
					sql: op === "in" ? `${ref} IN (${holes})` : `${ref} NOT IN (${holes})`,
				}
			}
			case "is":
				if (raw === "null") {
					if (this.defects.has("FILTER_IS_NULL_MATCHES_ALL")) return { args: [], sql: "1 = 1" }
					return { args: [], sql: `${ref} IS NULL` }
				}
				if (raw === "notnull" || raw === "not.null") return { args: [], sql: `${ref} IS NOT NULL` }
				if (raw === "true") return { args: [1], sql: `${ref} = ?` }
				if (raw === "false") return { args: [0], sql: `${ref} = ?` }
				throw new SqlError("invalid_filter", `is.${raw} is not a recognised predicate`)
			case "contains":
				return { args: [coerce(raw)], sql: `${ref} LIKE '%' || ? || '%' ESCAPE '\\'` }
			case "like":
			case "ilike": {
				/* `*` is the grammar's wildcard; % and _ are literals and must be escaped, or a
				 * value containing them matches far more than the caller asked for. */
				const pattern = this.defects.has("LIKE_UNESCAPED")
					? raw.replace(/\*/g, "%")
					: escapeLike(raw).replace(/\*/g, "%")
				const insensitive = op === "ilike" && !this.defects.has("FILTER_ILIKE_IS_LIKE")
				return {
					args: [insensitive ? pattern.toLowerCase() : pattern],
					sql: insensitive ? `LOWER(${ref}) LIKE ? ESCAPE '\\'` : `${ref} LIKE ? ESCAPE '\\'`,
				}
			}
			default:
				throw new SqlError("invalid_filter", `unknown operator "${op}"`)
		}
	}

	/** Set by compileOrder when the descending-drops-nulls defect applies to this query. */
	private dropNullsFor: string | null = null

	private compileOrder(expression: string | undefined, entity: EntityDef): string {
		this.dropNullsFor = null
		const terms: string[] = []

		if (expression !== undefined && expression !== "") {
			const rawTerms = splitTopLevel(expression)
			const used = this.defects.has("SORT_MULTI_KEY_IGNORED") ? rawTerms.slice(0, 1) : rawTerms
			for (const raw of used) {
				const [field, ...modifiers] = raw.split(".")
				/* Under the overclaim defect the backend refuses a field the document still declares
				 * sortable — the backend is not wrong to refuse, the document is wrong to promise. */
				const sortable = this.defects.has("SPEC_OVERCLAIMS_SORTABLE")
					? fieldsWhere(entity, "sortable").filter((f) => f !== OVERCLAIMED_FIELD)
					: fieldsWhere(entity, "sortable")
				if (field === undefined || !sortable.includes(field)) {
					throw new SqlError("invalid_order", `field "${field ?? ""}" is not sortable`)
				}
				const descending = modifiers.includes("desc")
				const nullsFirst = modifiers.includes("nullsfirst")
					? true
					: modifiers.includes("nullslast")
						? false
						: descending
				const declared = entity.fields.find((f) => f.name === field)
				const numeric = declared?.type === "integer" || declared?.type === "number"
				const asText =
					numeric && (this.defects.has("NUMERIC_COMPARED_AS_TEXT") || this.defects.has("SORT_NUMERIC_AS_TEXT"))
				const ref = asText ? `CAST(${col(field)} AS TEXT)` : col(field)
				terms.push(`${col(field)} IS NULL ${nullsFirst ? "DESC" : "ASC"}`)
				terms.push(`${ref} ${descending ? "DESC" : "ASC"}`)
				if (descending && this.defects.has("SORT_DESC_DROPS_NULLS")) {
					this.dropNullsFor = field
				}
			}
		}

		if (this.defects.has("ORDER_IGNORED")) {
			this.dropNullsFor = null
			return ""
		}

		/* The tiebreak is what makes pagination sound: without a total order, equal keys may come
		 * back in any order and a page boundary moves between requests. */
		if (this.defects.has("UNSTABLE_SORT")) {
			/* Without a tiebreak, rows with equal keys come back in whatever order the plan
			 * produced — arbitrary, and different between two identical queries. SQLite would
			 * otherwise fall back to rowid and look stable by accident, so ties are randomised
			 * to model the real behaviour rather than a friendlier version of it. */
			terms.push("random()")
		} else {
			terms.push(`${col(entity.identity)} ASC`)
		}

		return terms.length > 0 ? ` ORDER BY ${terms.join(", ")}` : ""
	}
}

/* ---------------------------------------------------------------------- helpers */

function toSql(value: unknown): SqlValue {
	if (value === null || value === undefined) return null
	if (typeof value === "boolean") return value ? 1 : 0
	if (typeof value === "object") return JSON.stringify(value)
	return value as SqlValue
}

function coerce(raw: string, asText = false): SqlValue {
	if (raw === "null") return null
	if (raw === "true") return 1
	if (raw === "false") return 0
	/* A numeric column compared as text needs a text bind too, or SQLite would compare a TEXT
	 * expression against an INTEGER and match nothing at all — a different bug than the one
	 * being modelled. */
	if (!asText && raw !== "" && !Number.isNaN(Number(raw))) return Number(raw)
	return raw
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
