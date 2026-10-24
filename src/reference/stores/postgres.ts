/**
 * Postgres-backed storage for the reference backend.
 *
 * Present because Postgres disagrees with SQLite in exactly the places API contracts are
 * ambiguous, which makes the pair a differential oracle rather than a redundant one:
 *
 *   - Types are enforced, so a value is stored as its declared type, not by affinity.
 *   - Collation is locale-aware, so ordering of unicode and mixed case is a real decision.
 *   - `LIKE` and `ILIKE` are genuinely different operators rather than one with a pragma.
 *
 * Each server instance gets its own scratch database, dropped on close, so runs never collide.
 */

import postgres from "postgres"
import type { DefectSet } from "../defects/defect-set.ts"
import { ENTITIES } from "../model/entities.ts"
import type { EntityDef, FieldDef } from "../model/types.ts"
import type { SelectPlan } from "../query-types.ts"
import type { Row, Store } from "../store-api.ts"
import { type SqlFlavor, type SqlParam, compileOrder, compileWhere, likeText } from "./sql-compile.ts"

/** What the store needs of a Postgres connection. postgres.js's client is one; a test passes its own. */
export interface PgConnection {
	unsafe(query: string, args?: SqlParam[]): PromiseLike<readonly Row[]>
	end(options: { timeout: number }): Promise<void>
}

/** Opens a connection pool of at most `max` sessions to one database. */
export type PgConnect = (database: string, max: number) => PgConnection

/** The real driver: postgres.js against the server the environment names, its notices silenced. */
export function connectPostgres(database: string, max: number): ReturnType<typeof postgres> {
	return postgres({ database, max, onnotice: () => {} })
}

const PG_TYPE: Record<FieldDef["type"], string> = {
	boolean: "boolean",
	integer: "bigint",
	number: "double precision",
	array: "text",
	object: "text",
	string: "text",
}

function ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`
}

/* How Postgres spells what the shared compiler leaves to the engine. */
function pgFlavor(): SqlFlavor {
	return {
		binary: (expr) => `${expr} COLLATE "C"`,
		bind: (args, value) => {
			args.push(value)
			return `$${args.length}`
		},
		bool: (value) => value,
		/* Reads name the declared column. Under COLUMN_NAME_MISMATCH DDL named it otherwise,
		 * and Postgres refuses the read outright where SQLite might silently answer. */
		column: (_entity, field) => ident(field),
		hasElement: (expr, element, args) => {
			args.push(element)
			return `jsonb_exists(${expr}::jsonb, $${args.length})`
		},
		like: (expr, { insensitive, segments }, args) => {
			args.push(likeText(segments))
			return `${expr} ${insensitive ? "ILIKE" : "LIKE"} $${args.length} ESCAPE '\\'`
		},
		position: (expr, { caseSensitive, text }, args) => {
			args.push(text)
			return caseSensitive
				? `strpos(${expr}, $${args.length}::text)`
				: `strpos(lower(${expr}), lower($${args.length}::text))`
		},
		random: "random()",
		toText: (expr) => `${expr}::text`,
	}
}

/* The store's working parts: its database, the admin session that made it, and what it models. */
interface PgParts {
	sql: PgConnection
	admin: PgConnection
	dbName: string
	defects: DefectSet
	entities: readonly EntityDef[]
}

export class PgStore implements Store {
	private readonly flavor: SqlFlavor = pgFlavor()
	private readonly sql: PgConnection
	private readonly admin: PgConnection
	private readonly dbName: string
	private readonly defects: DefectSet
	private readonly entities: readonly EntityDef[]

	private constructor(parts: PgParts) {
		this.sql = parts.sql
		this.admin = parts.admin
		this.dbName = parts.dbName
		this.defects = parts.defects
		this.entities = parts.entities
	}

	static async create(
		defects: DefectSet,
		entities: readonly EntityDef[] = ENTITIES,
		connect: PgConnect = connectPostgres,
	): Promise<PgStore> {
		const dbName = `oat_ref_${process.pid}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
		const admin = connect("postgres", 1)
		await admin.unsafe(`CREATE DATABASE ${ident(dbName)}`)
		const sql = connect(dbName, 4)
		const store = new PgStore({ admin, dbName, defects, entities, sql })
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
		for (const entity of this.entities) {
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
		return this.defects.has("COLUMN_NAME_MISMATCH") && name === "name" ? "mislabeled_name" : name
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

	async insert(entity: EntityDef, record: Row): Promise<Row> {
		const names = entity.fields.map((f) => f.name).filter((n) => record[n] !== undefined)
		const columns = names.map((n) => ident(this.physical(n))).join(", ")
		const holes = names.map((_, i) => `$${i + 1}`).join(", ")
		await this.sql.unsafe(
			`INSERT INTO ${ident(entity.plural)} (${columns}) VALUES (${holes})`,
			names.map((n) => toPg(record[n])),
		)
		return (await this.byId(entity, record[entity.identity] as string | number)) ?? record
	}

	async byId(entity: EntityDef, id: string | number): Promise<Row | null> {
		const rows = await this.sql.unsafe(
			`SELECT ${this.selectList(entity)} FROM ${ident(entity.plural)} WHERE ${ident(this.physical(entity.identity))} = $1`,
			[id],
		)
		const row = rows[0] as Row | undefined
		return row === undefined ? null : this.decode(entity, row)
	}

	async update(entity: EntityDef, id: string | number, patch: Row): Promise<Row | null> {
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

	async remove(entity: EntityDef, id: string | number): Promise<void> {
		await this.sql.unsafe(`DELETE FROM ${ident(entity.plural)} WHERE ${ident(this.physical(entity.identity))} = $1`, [
			id,
		])
	}

	async select(entity: EntityDef, plan: SelectPlan): Promise<Row[]> {
		const args: SqlParam[] = []
		const where = compileWhere(plan.where, { args, entity, flavor: this.flavor })
		const order = compileOrder(plan, entity, this.flavor)
		const rows = await this.sql.unsafe(
			`SELECT ${this.selectList(entity)} FROM ${ident(entity.plural)} WHERE ${where}${order}`,
			args,
		)
		return rows.map((row) => this.decode(entity, row))
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
				field.type === "integer" || field.type === "number"
					? Number(raw)
					: field.type === "boolean"
						? raw === true
						: (field.type === "object" || field.type === "array") && typeof raw === "string"
							? JSON.parse(raw)
							: raw
		}
		return out
	}
}

function toPg(value: unknown): SqlParam {
	if (value === undefined) return null
	if (value !== null && typeof value === "object") return JSON.stringify(value)
	return value as SqlParam
}
