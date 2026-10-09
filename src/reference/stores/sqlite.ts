/**
 * SQLite-backed storage for the reference backend.
 *
 * The in-memory store evaluates the query AST in JavaScript, which quietly sidesteps what breaks
 * real APIs: collation, type affinity, and result order when a sort has no total order. Running
 * the same predicates through a real engine is what makes a check that passes here mean something.
 *
 * The engine is supplied as a driver, so the same SQL runs in-process via `node:sqlite` and
 * remotely against Cloudflare D1. That second target is not redundancy: D1 is a different build
 * with different compile flags, reached over the network, backed by a database that persists
 * between runs — three properties an in-process store cannot exhibit.
 */

import type { DefectSet } from "../defects.ts"
import type { EntityDef, FieldDef } from "../model.ts"
import { ENTITIES } from "../model.ts"
import type { SelectPlan } from "../query.ts"
import type { Row, Store } from "../store-api.ts"
import { type SqlFlavour, type SqlParam, compileOrder, compileWhere, globText } from "./sql-compile.ts"
import type { SqliteDriver, SqlValue } from "./sqlite-driver.ts"

/** SQLite storage class per declared field type. */
const AFFINITY: Record<FieldDef["type"], string> = {
	boolean: "INTEGER",
	integer: "INTEGER",
	number: "REAL",
	array: "TEXT",
	object: "TEXT",
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
	private readonly flavour: SqlFlavour

	private constructor(
		private readonly defects: DefectSet,
		private readonly db: SqliteDriver,
		private readonly prefix: string,
		private readonly entities: readonly EntityDef[],
	) {
		this.flavour = {
			binary: (expr) => expr,
			bind: (args, value) => {
				args.push(value)
				return "?"
			},
			bool: (value) => (value ? 1 : 0),
			column: (_entity, field) => col(field),
			hasElement: (expr, element, args) => {
				args.push(element)
				return `EXISTS (SELECT 1 FROM json_each(${expr}) WHERE value = ?)`
			},
			/* GLOB is SQLite's case-sensitive matcher and needs no pragma, so the same SQL behaves
			 * identically in-process and on D1. Case-insensitive matching folds both sides with
			 * the engine's own LOWER so the two always agree on what "lower" means. */
			like: (expr, segments, insensitive, args) => {
				args.push(globText(segments))
				return insensitive ? `LOWER(${expr}) GLOB LOWER(?)` : `${expr} GLOB ?`
			},
			position: (expr, needle, caseSensitive, args) => {
				args.push(needle)
				return caseSensitive ? `instr(${expr}, ?)` : `instr(LOWER(${expr}), LOWER(?))`
			},
			random: "random()",
			toText: (expr) => `CAST(${expr} AS TEXT)`,
		}
	}

	/**
	 * Schema creation is a set of round trips on a networked engine, so it cannot live in a
	 * constructor. `prefix` isolates one run's tables from another's on a shared database.
	 */
	static async create(
		defects: DefectSet,
		driver: SqliteDriver,
		prefix = "",
		entities: readonly EntityDef[] = ENTITIES,
	): Promise<SqlStore> {
		const store = new SqlStore(defects, driver, prefix, entities)
		/* One statement per table would be one network round trip per table. Both drivers accept
		 * a multi-statement script, so the whole schema costs a single trip. */
		await driver.exec(entities.map((entity) => store.ddl(entity)).join(";\n"))
		return store
	}

	async close(): Promise<void> {
		/* Persistent engines keep whatever this run created unless it is dropped. Failures here
		 * are swallowed: teardown must not mask the result the run was there to produce. */
		if (this.prefix !== "") {
			for (const entity of this.entities) {
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

	async byId(entity: EntityDef, id: string | number): Promise<Row | null> {
		const rows = await this.db.all(
			`SELECT ${this.selectList(entity)} FROM ${tableName(entity, this.prefix)} WHERE ${col(entity.identity)} = ?`,
			[id],
		)
		const row = rows[0]
		return row === undefined ? null : this.decode(entity, row)
	}

	async update(entity: EntityDef, id: string | number, patch: Row): Promise<Row | null> {
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

	async remove(entity: EntityDef, id: string | number): Promise<void> {
		await this.db.run(`DELETE FROM ${tableName(entity, this.prefix)} WHERE ${col(entity.identity)} = ?`, [id])
	}

	async select(entity: EntityDef, plan: SelectPlan): Promise<Row[]> {
		const args: SqlParam[] = []
		const where = compileWhere(plan.where, entity, this.flavour, args)
		const order = compileOrder(plan.order, plan.collation, plan.shuffleTies, entity, this.flavour)
		const rows = await this.db.all(
			`SELECT ${this.selectList(entity)} FROM ${tableName(entity, this.prefix)} WHERE ${where}${order}`,
			args.map(toSql),
		)
		return rows.map((row) => this.decode(entity, row))
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
			out[field.name] =
				field.type === "boolean"
					? raw === 1
					: (field.type === "object" || field.type === "array") && typeof raw === "string"
						? JSON.parse(raw)
						: raw
		}
		return out
	}
}

function toSql(value: unknown): SqlValue {
	if (value === null || value === undefined) return null
	if (typeof value === "boolean") return value ? 1 : 0
	if (typeof value === "object") return JSON.stringify(value)
	return value as SqlValue
}
