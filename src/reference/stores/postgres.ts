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
import type { DefectSet } from "../defects.ts"
import { ENTITIES, type EntityDef, type FieldDef } from "../model.ts"
import type { SelectPlan } from "../query.ts"
import type { Row, Store } from "../store-api.ts"
import { type SqlFlavour, type SqlParam, compileOrder, compileWhere, likeText } from "./sql-compile.ts"

type Sql = ReturnType<typeof postgres>

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

export class PgStore implements Store {
	private readonly flavour: SqlFlavour

	private constructor(
		private readonly sql: Sql,
		private readonly admin: Sql,
		private readonly dbName: string,
		private readonly defects: DefectSet,
		private readonly entities: readonly EntityDef[],
	) {
		this.flavour = {
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
			like: (expr, segments, insensitive, args) => {
				args.push(likeText(segments))
				return `${expr} ${insensitive ? "ILIKE" : "LIKE"} $${args.length} ESCAPE '\\'`
			},
			position: (expr, needle, caseSensitive, args) => {
				args.push(needle)
				return caseSensitive
					? `strpos(${expr}, $${args.length}::text)`
					: `strpos(lower(${expr}), lower($${args.length}::text))`
			},
			random: "random()",
			toText: (expr) => `${expr}::text`,
		}
	}

	static async create(defects: DefectSet, entities: readonly EntityDef[] = ENTITIES): Promise<PgStore> {
		const dbName = `oat_ref_${process.pid}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
		const admin = postgres({ database: "postgres", max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE DATABASE ${ident(dbName)}`)
		const sql = postgres({ database: dbName, max: 4, onnotice: () => {} })
		const store = new PgStore(sql, admin, dbName, defects, entities)
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
		const where = compileWhere(plan.where, entity, this.flavour, args)
		const order = compileOrder(plan.order, plan.collation, plan.shuffleTies, entity, this.flavour)
		const rows = (await this.sql.unsafe(
			`SELECT ${this.selectList(entity)} FROM ${ident(entity.plural)} WHERE ${where}${order}`,
			args,
		)) as unknown as Row[]
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
