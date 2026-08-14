/**
 * Postgres-backed storage for the reference backend.
 *
 * Present because Postgres disagrees with SQLite in exactly the places API contracts are
 * ambiguous, which makes the pair a differential oracle rather than a redundant one:
 *
 *   - `ORDER BY x ASC` puts NULLs **last**; SQLite puts them first.
 *   - Types are enforced, so bad input is rejected rather than silently coerced.
 *   - Collation is locale-aware, so ordering of unicode and mixed case is a real decision.
 *   - `LIKE` is case-sensitive and `ILIKE` genuinely differs — on SQLite the two are
 *     indistinguishable for ASCII, which makes an ilike check structurally untestable there.
 *
 * Each server instance gets its own scratch database, dropped on close, so runs never collide.
 */

import postgres from "postgres"
import type { DefectSet } from "../defects.ts"
import { ENTITIES, type EntityDef, type FieldDef, OVERCLAIMED_FIELD, fieldsWhere } from "../model.ts"
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

type Sql = ReturnType<typeof postgres>

/** Values the driver accepts as bound parameters. */
type PgParam = string | number | boolean | null

const PG_TYPE: Record<FieldDef["type"], string> = {
	boolean: "boolean",
	integer: "bigint",
	number: "double precision",
	string: "text",
}

function ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`
}

export class PgStore implements Store {
	private sequence = 0

	private constructor(
		private readonly sql: Sql,
		private readonly admin: Sql,
		private readonly dbName: string,
		private readonly defects: DefectSet,
	) {}

	static async create(defects: DefectSet): Promise<PgStore> {
		const dbName = `oat_ref_${process.pid}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
		const admin = postgres({ database: "postgres", max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE DATABASE ${ident(dbName)}`)
		const sql = postgres({ database: dbName, max: 4, onnotice: () => {} })
		const store = new PgStore(sql, admin, dbName, defects)
		await store.migrate()
		return store
	}

	async close(): Promise<void> {
		await this.sql.end({ timeout: 5 })
		/* Drop with FORCE: a lingering session would otherwise leave scratch databases behind on
		 * every run, which is the same litter problem oat reports in the systems it tests. */
		try {
			await this.admin.unsafe(`DROP DATABASE IF EXISTS ${ident(this.dbName)} WITH (FORCE)`)
		} finally {
			await this.admin.end({ timeout: 5 })
		}
	}

	private async migrate(): Promise<void> {
		/* A case-insensitive collation that genuinely differs from the database default.
		 *
		 * The scratch database inherits the cluster's locale, which here is C — so `COLLATE "C"`
		 * would be a no-op and the collation defect would be invisible. Declaring an explicit ICU
		 * collation makes the disagreement real regardless of how the cluster was initialised. */
		await this.sql.unsafe(
			`CREATE COLLATION oat_ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
		)
		for (const entity of ENTITIES) {
			const columns = entity.fields.map((field) => {
				const notNull = field.required === true ? " NOT NULL" : ""
				return `${ident(this.physical(field.name))} ${PG_TYPE[field.type]}${notNull}`
			})
			await this.sql.unsafe(
				`CREATE TABLE ${ident(entity.plural)} (${columns.join(", ")}, PRIMARY KEY (${ident(this.physical(entity.identity))}))`,
			)
		}
	}

	/** The stored column for a field — diverges from the declared name only under the defect. */
	private physical(name: string): string {
		return this.defects.has("COLUMN_NAME_MISMATCH") && name === "name" ? "mislabelled_name" : name
	}

	/**
	 * Explicit projection, aliased back to declared names.
	 *
	 * Under COLUMN_NAME_MISMATCH the read asks for a column that does not exist. Postgres errors
	 * outright where SQLite's double-quoted-string fallback silently yields the identifier as a
	 * literal — the same defect, two failure modes, which is the point of running both.
	 */
	private selectList(entity: EntityDef): string {
		return entity.fields
			.map((f) => {
				if (!this.defects.has("COLUMN_NAME_MISMATCH") || f.name !== "name") {
					return `${ident(f.name)} AS ${ident(f.name)}`
				}
				return `'${f.name}'::text AS ${ident(f.name)}`
			})
			.join(", ")
	}

	nextId(prefix: string): string {
		this.sequence += 1
		return `${prefix}_${String(this.sequence).padStart(6, "0")}`
	}

	now(): number {
		return 1_700_000_000_000 + this.sequence * 1000
	}

	async insert(entity: EntityDef, record: Row): Promise<Row> {
		const names = entity.fields.map((f) => f.name).filter((n) => record[n] !== undefined)
		const columns = names.map((n) => ident(this.physical(n))).join(", ")
		const holes = names.map((_, i) => `$${i + 1}`).join(", ")
		await this.sql.unsafe(
			`INSERT INTO ${ident(entity.plural)} (${columns}) VALUES (${holes})`,
			names.map((n) => toPg(record[n])),
		)
		return (await this.byId(entity, String(record[entity.identity]))) ?? record
	}

	async byId(entity: EntityDef, id: string): Promise<Row | null> {
		const rows = await this.sql.unsafe(
			`SELECT ${this.selectList(entity)} FROM ${ident(entity.plural)} WHERE ${ident(this.physical(entity.identity))} = $1`,
			[id],
		)
		const row = rows[0] as Row | undefined
		return row === undefined ? null : this.decode(entity, row)
	}

	async update(entity: EntityDef, id: string, patch: Row): Promise<Row | null> {
		if (this.defects.has("CONCURRENT_WRITE_LOST")) return this.readModifyWrite(entity, id, patch)
		const names = Object.keys(patch).filter((n) => entity.fields.some((f) => f.name === n))
		if (names.length > 0) {
			const assignments = names.map((n, i) => `${ident(this.physical(n))} = $${i + 1}`).join(", ")
			await this.sql.unsafe(
				`UPDATE ${ident(entity.plural)} SET ${assignments} WHERE ${ident(this.physical(entity.identity))} = $${names.length + 1}`,
				[...names.map((n) => toPg(patch[n])), id],
			)
		}
		return this.byId(entity, id)
	}

	/**
	 * Reads the row, yields, then writes every column back — the `save(entity)` pattern.
	 *
	 * Under concurrency the second writer reinstates whatever it read before the first writer
	 * committed, so a patch to a different field is silently reverted. The yield is what makes
	 * the window observable rather than dependent on scheduler luck.
	 */
	private async readModifyWrite(entity: EntityDef, id: string, patch: Row): Promise<Row | null> {
		const current = await this.byId(entity, id)
		if (current === null) return null
		await new Promise((resolve) => setTimeout(resolve, 15))
		const merged = { ...current, ...patch }
		const names = entity.fields.map((f) => f.name)
		const assignments = names.map((n, i) => `${ident(this.physical(n))} = $${i + 1}`).join(", ")
		await this.sql.unsafe(
			`UPDATE ${ident(entity.plural)} SET ${assignments} WHERE ${ident(this.physical(entity.identity))} = $${names.length + 1}`,
			[...names.map((n) => toPg(merged[n])), id],
		)
		return this.byId(entity, id)
	}

	async remove(entity: EntityDef, id: string): Promise<void> {
		await this.sql.unsafe(
			`DELETE FROM ${ident(entity.plural)} WHERE ${ident(this.physical(entity.identity))} = $1`,
			[id],
		)
	}

	/**
	 * Restores declared shapes. `bigint` arrives as a string from the wire protocol and would
	 * fail its own response schema, and a NULL column must read back as null rather than absent.
	 */
	private decode(entity: EntityDef, row: Row): Row {
		const out: Row = {}
		for (const field of entity.fields) {
			const raw = row[field.name]
			if (raw === undefined || raw === null) {
				out[field.name] = null
				continue
			}
			out[field.name] =
				field.type === "integer"
					? Number(raw)
					: field.type === "number"
						? Number(raw)
						: field.type === "boolean"
							? raw === true
							: raw
		}
		return out
	}

	async query(
		entity: EntityDef,
		scope: Record<string, string>,
		params: QueryParams,
		options: QueryOptions,
	): Promise<QueryResult> {
		const where: string[] = []
		const args: PgParam[] = []
		const hole = (): string => `$${args.length + 1}`

		const scoped = !(this.defects.has("TENANT_LEAK_VIA_FILTER") && params.filter !== undefined)
		for (const parent of scoped ? entity.parents : []) {
			const value = scope[parent]
			if (value === undefined) continue
			if (!entity.fields.some((f) => f.name === parent)) continue
			where.push(`${ident(this.physical(parent))} = ${hole()}`)
			args.push(value)
		}

		const soft = options.softDeleteField
		if (soft !== undefined && !this.defects.has("SOFT_DELETE_LEAK")) {
			if (params.filter?.includes(soft) !== true) {
				where.push(`${ident(this.physical(soft))} IS NULL`)
			}
		}

		if (params.filter !== undefined && params.filter !== "") {
			where.push(this.compileFilter(params.filter, entity, args))
		}

		if (params.q !== undefined && params.q !== "" && !this.defects.has("SEARCH_IGNORED")) {
			const searchable = fieldsWhere(entity, "searchable")
			if (searchable.length > 0) {
				const clauses = searchable.map((f) => {
					args.push(`%${escapeLike(params.q ?? "")}%`)
					return `${ident(this.physical(f))}::text ILIKE $${args.length} ESCAPE '\\'`
				})
				where.push(`(${clauses.join(" OR ")})`)
			}
		}

		const dropNulls: string[] = []
		const orderSql = this.compileOrder(params.order, entity, dropNulls)
		for (const field of dropNulls) where.push(`${ident(this.physical(field))} IS NOT NULL`)

		const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""

		const countWhere = this.defects.has("COUNT_IGNORES_FILTER") ? "" : whereSql
		const countArgs = this.defects.has("COUNT_IGNORES_FILTER") ? [] : args
		const countRows = (await this.sql.unsafe(
			`SELECT COUNT(*)::bigint AS n FROM ${ident(entity.plural)}${countWhere}`,
			countArgs,
		)) as unknown as Array<{ n: string }>
		const total = Number(countRows[0]?.n ?? 0)

		const requested = params.limit ?? entity.defaultLimit
		const limit = this.defects.has("LIMIT_EXCEEDS_MAX")
			? requested
			: Math.min(requested, entity.maxLimit)

		let offset: number
		let page: number | null
		if (params.cursor !== undefined && params.cursor !== "") {
			const afterId = decodeCursor(params.cursor)
			/* The cursor boundary must be resolved under exactly the listing's ordering. Under the
			 * defect it is resolved with a different collation, so the index found here is not the
			 * index the listing would have produced and the page boundary lands elsewhere. */
			/* Collation "C" against the listing's locale default: the two disagree on case and on
			 * anything non-ASCII, so the boundary resolves to a different row. */
			const cursorOrderSql = this.defects.has("COLLATION_INCONSISTENT")
				? orderSql.replace(/(".*?")( (?:ASC|DESC))/g, "$1 COLLATE oat_ci$2")
				: orderSql
			const ordered = (await this.sql.unsafe(
				`SELECT ${ident(this.physical(entity.identity))} AS id FROM ${ident(entity.plural)}${whereSql}${cursorOrderSql}`,
				args,
			)) as unknown as Array<{ id: string }>
			const index = ordered.findIndex((r) => String(r.id) === afterId)
			offset = index === -1 ? 0 : index + (this.defects.has("CURSOR_DRIFT") ? 0 : 1)
			page = null
		} else {
			const requestedPage = Math.max(params.page ?? 1, 1)
			offset =
				(requestedPage - 1) * limit +
				(this.defects.has("OFF_BY_ONE_PAGE") && requestedPage > 1 ? 1 : 0)
			page = requestedPage
		}

		const limitSql = this.defects.has("LIMIT_IGNORED") ? "ALL" : String(limit)
		const rows = (await this.sql.unsafe(
			`SELECT ${this.selectList(entity)} FROM ${ident(entity.plural)}${whereSql}${orderSql} LIMIT ${limitSql} OFFSET ${offset}`,
			args,
		)) as unknown as Row[]

		const effective =
			this.defects.has("EMPTY_RESULT_RETURNS_ALL") && rows.length === 0 && where.length > 0
				? ((await this.sql.unsafe(
						`SELECT ${this.selectList(entity)} FROM ${ident(entity.plural)}${orderSql} LIMIT ${limitSql} OFFSET ${offset}`,
						[],
					)) as unknown as Row[])
				: rows

		const decoded = effective.map((row) => this.decode(entity, row))
		const transformed =
			options.transform === undefined ? decoded : decoded.map((r) => options.transform?.(r) ?? r)
		const last = transformed.at(-1)
		const hasMore = this.defects.has("HASMORE_ALWAYS_FALSE") ? false : offset + decoded.length < total

		return {
			count: this.defects.has("COUNT_ALWAYS_ZERO") ? 0 : total,
			hasMore,
			items: transformed.map((row) =>
				project(
					row,
					params.select,
					this.defects.has("SELECT_IGNORED"),
					this.defects.has("SPEC_OVERCLAIMS_SELECTABLE") ? [OVERCLAIMED_FIELD] : [],
				),
			),
			limit,
			nextCursor:
				hasMore && last !== undefined ? encodeCursor(String(last[entity.identity])) : null,
			page,
		}
	}

	private compileFilter(expression: string, entity: EntityDef, args: PgParam[]): string {
		const trimmed = expression.trim()
		const hole = (value: PgParam): string => {
			args.push(value)
			return `$${args.length}`
		}

		const group = /^(and|or)\((.*)\)$/s.exec(trimmed)
		if (group?.[1] && group[2] !== undefined) {
			const parts = splitTopLevel(group[2]).map((p) => this.compileFilter(p, entity, args))
			if (parts.length === 0) throw new SqlError("invalid_filter", "empty filter group")
			const effective = this.defects.has("FILTER_GROUP_COMBINATOR_SWAPPED")
				? (group[1] === "and" ? "or" : "and")
				: group[1]
			return `(${parts.join(effective === "and" ? " AND " : " OR ")})`
		}

		const segments = trimmed.split(".")
		if (segments.length < 3) {
			throw new SqlError("invalid_filter", `malformed filter term "${trimmed}"`)
		}
		const [field, op] = segments as [string, string, ...string[]]
		const raw = segments.slice(2).join(".")

		/* Under the overclaim defect the backend refuses a field the document still declares
		 * filterable — the backend is not wrong to refuse, the document is wrong to promise. */
		const filterable = this.defects.has("SPEC_OVERCLAIMS_FILTERABLE")
			? fieldsWhere(entity, "filterable").filter((f) => f !== OVERCLAIMED_FIELD)
			: fieldsWhere(entity, "filterable")
		if (!filterable.includes(field)) {
			if (this.defects.has("FILTER_IGNORED")) return "TRUE"
			throw new SqlError("invalid_filter", `field "${field}" is not filterable`)
		}

		const declared = entity.fields.find((f) => f.name === field)
		const numeric = declared?.type === "integer" || declared?.type === "number"
		/* Compare as text unless the column is genuinely numeric: Postgres refuses to compare a
		 * bigint against an arbitrary string, and the grammar's values arrive untyped. Under the
		 * defect even numeric columns go through text, which is what makes `amount > 9` miss 10. */
		const asText = !numeric || this.defects.has("NUMERIC_COMPARED_AS_TEXT")
		const ref = ident(this.physical(field))
		const cast = asText ? "::text" : ""

		switch (op) {
			case "eq":
				if (this.defects.has("FILTER_EQ_NOT_APPLIED")) return "TRUE"
				return `${ref}${cast} = ${hole(coerce(raw, asText ? undefined : declared))}`
			case "neq":
				/* NULL must be re-admitted explicitly: `col <> x` is NULL, not true, for NULL rows,
				 * so they silently vanish without the IS NULL branch. */
				return this.defects.has("NEQ_DROPS_NULLS")
					? `${ref}${cast} <> ${hole(coerce(raw, asText ? undefined : declared))}`
					: `(${ref}${cast} <> ${hole(coerce(raw, asText ? undefined : declared))} OR ${ref} IS NULL)`
			case "gt":
				return `${ref}${cast} > ${hole(coerce(raw, asText ? undefined : declared))}`
			case "gte":
				return `${ref}${cast} >= ${hole(coerce(raw, asText ? undefined : declared))}`
			case "lt":
				return `${ref}${cast} < ${hole(coerce(raw, asText ? undefined : declared))}`
			case "lte":
				return `${ref}${cast} <= ${hole(coerce(raw, asText ? undefined : declared))}`
			case "in":
			case "nin": {
				const members = stripParens(raw)
					.split(",")
					.map((s) => coerce(s.trim(), asText ? undefined : declared))
				const holes = members.map((m) => hole(m)).join(", ")
				return op === "in" ? `${ref}${cast} IN (${holes})` : `${ref}${cast} NOT IN (${holes})`
			}
			case "is":
				if (raw === "null") return `${ref} IS NULL`
				if (raw === "true") return `${ref} IS TRUE`
				if (raw === "false") return `${ref} IS FALSE`
				throw new SqlError("invalid_filter", `is.${raw} is not a recognised predicate`)
			case "like":
			case "ilike": {
				const pattern = this.defects.has("LIKE_UNESCAPED")
					? raw.replace(/\*/g, "%")
					: escapeLike(raw).replace(/\*/g, "%")
				/* Postgres distinguishes these; SQLite cannot for ASCII. Honouring the distinction
				 * is only meaningful on an engine that has it. */
				const operator = op === "ilike" ? "ILIKE" : "LIKE"
				return `${ref}${cast} ${operator} ${hole(pattern)} ESCAPE '\\'`
			}
			default:
				throw new SqlError("invalid_filter", `unknown operator "${op}"`)
		}
	}

	private compileOrder(
		expression: string | undefined,
		entity: EntityDef,
		dropNulls: string[],
	): string {
		if (this.defects.has("ORDER_IGNORED")) return ""
		const terms: string[] = []

		if (expression !== undefined && expression !== "") {
			for (const raw of splitTopLevel(expression)) {
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
				const ref =
					numeric && this.defects.has("NUMERIC_COMPARED_AS_TEXT")
						? `${ident(this.physical(field))}::text`
						: ident(this.physical(field))
				terms.push(
					`${ref} ${descending ? "DESC" : "ASC"} NULLS ${nullsFirst ? "FIRST" : "LAST"}`,
				)
				if (descending && this.defects.has("SORT_DESC_DROPS_NULLS")) dropNulls.push(field)
			}
		}

		if (this.defects.has("UNSTABLE_SORT")) {
			terms.push("random()")
		} else {
			terms.push(`${ident(this.physical(entity.identity))} ASC`)
		}

		return terms.length > 0 ? ` ORDER BY ${terms.join(", ")}` : ""
	}
}

function toPg(value: unknown): PgParam {
	if (value === undefined) return null
	if (value !== null && typeof value === "object") return JSON.stringify(value)
	return value as PgParam
}

function coerce(raw: string, field: FieldDef | undefined): PgParam {
	if (raw === "null") return null
	if (field?.type === "integer" || field?.type === "number") {
		const n = Number(raw)
		if (Number.isNaN(n)) throw new SqlError("invalid_filter", `"${raw}" is not a number`)
		return n
	}
	return raw
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
