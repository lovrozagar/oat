import { compileFilter, compileOrder, project, QueryError } from "./query.ts"
import { schemaStatements } from "./schema.ts"
import {
	allColumns,
	entityByName,
	hasDefect,
	numericFields,
	parentIdField,
	type Entity,
	type World,
} from "./types.ts"

export type Row = Record<string, unknown>

export interface Grant {
	accepted: boolean
	entity: string
	grantId: string
	granteeKey: string
	itemId: string
	ownerOrg: string
	token: string
}

export interface Driver {
	exec(sql: string): Promise<void>
	run(sql: string, args: Array<string | number | null>): Promise<void>
	all(sql: string, args: Array<string | number | null>): Promise<Row[]>
}

export interface ListParams {
	filter?: string
	order?: string
	select?: string
	q?: string
	limit?: number
	page?: number
	cursor?: string
}

export class WorldStore {
	db: Driver
	world: World
	constructor(db: Driver, world: World) {
		this.db = db
		this.world = world
	}

	static async open(db: Driver, world: World): Promise<WorldStore> {
		for (const sql of schemaStatements(world)) {
			await db.exec(sql)
		}
		return new WorldStore(db, world)
	}

	/** Schema already applied by provision. Use this on Workers so the first request stays under CPU. */
	static attach(db: Driver, world: World): WorldStore {
		return new WorldStore(db, world)
	}

	async get(entity: Entity, orgId: string, id: string): Promise<Row | null> {
		const extra = entity.softDelete === true ? ` AND deleted_at IS NULL` : ""
		if (hasDefect(this.world, "ignore-tenant-get")) {
			const rows = await this.db.all(
				`SELECT * FROM "${entity.plural}" WHERE id = ?${extra}`,
				[id],
			)
			return rows[0] ?? null
		}
		const rows = await this.db.all(
			`SELECT * FROM "${entity.plural}" WHERE id = ? AND org_id = ?${extra}`,
			[id, orgId],
		)
		return rows[0] ?? null
	}

	async existsElsewhere(entity: Entity, id: string, orgId: string): Promise<boolean> {
		const extra = entity.softDelete === true ? ` AND deleted_at IS NULL` : ""
		const rows = await this.db.all(
			`SELECT 1 AS n FROM "${entity.plural}" WHERE id = ? AND org_id != ?${extra}`,
			[id, orgId],
		)
		return rows.length > 0
	}

	async list(entity: Entity, scope: Record<string, string>, params: ListParams): Promise<{
		items: Row[]
		count: number
		hasMore: boolean
		nextCursor: string | null
		page: number
		limit: number
	}> {
		const columns = new Set(allColumns(entity))
		const numeric = new Set(numericFields(entity))
		const filterable = [
			"id",
			"org_id",
			...entity.fields.filter((f) => f.filterable === true).map((f) => f.name),
			"created_at",
			"updated_at",
		]
		const sortable = [
			"id",
			...entity.fields.filter((f) => f.sortable === true).map((f) => f.name),
			"created_at",
			"updated_at",
		]
		const searchable = entity.fields.filter((f) => f.searchable === true).map((f) => f.name)
		const selectable = allColumns(entity)
		const maxLimit = entity.maxLimit ?? 100

		const where: string[] = [`org_id = ?`]
		const args: Array<string | number | null> = [scope.org_id ?? ""]
		if (entity.softDelete === true) where.push(`deleted_at IS NULL`)
		const parent = parentIdField(entity)
		if (parent !== null && scope[parent] !== undefined) {
			where.push(`"${parent}" = ?`)
			args.push(scope[parent] as string)
		}

		const dropFilter = hasDefect(this.world, "drop-filter")
		const filterAfterPage = hasDefect(this.world, "filter-after-page")
		if (params.filter !== undefined && params.filter !== "" && !dropFilter && !filterAfterPage) {
			const compiled = compileFilter(params.filter, filterable, columns, numeric)
			where.push(compiled.sql)
			args.push(...compiled.args)
		} else if (params.filter !== undefined && params.filter !== "") {
			/* Parse so unknown fields still 400; apply later or not at all. */
			compileFilter(params.filter, filterable, columns, numeric)
		}
		if (params.q !== undefined && params.q !== "" && searchable.length > 0) {
			const needle = `%${params.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
			where.push(`(${searchable.map((f) => `LOWER("${f}") LIKE LOWER(?) ESCAPE '\\'`).join(" OR ")})`)
			for (const _ of searchable) args.push(needle)
		}

		const whereSql = `WHERE ${where.join(" AND ")}`
		const counted = await this.db.all(`SELECT COUNT(*) AS n FROM "${entity.plural}" ${whereSql}`, args)
		const count = Number(counted[0]?.n ?? 0)
		const order = compileOrder(params.order ?? "created_at.desc", sortable, columns, "id")
		const requested = params.limit ?? 20
		const limit = Math.max(1, Math.min(requested, maxLimit))
		const page = Math.max(params.page ?? 1, 1)
		let offset = (page - 1) * limit
		if (
			params.cursor !== undefined
			&& params.cursor !== ""
			&& !hasDefect(this.world, "ignore-cursor")
		) {
			const after = decodeCursor(params.cursor)
			const idx = await this.db.all(
				`SELECT id FROM "${entity.plural}" ${whereSql} ORDER BY ${order.sql}`,
				args,
			)
			const at = idx.findIndex((row) => String(row.id) === after)
			offset = at === -1 ? 0 : at + 1
		}
		const rows = await this.db.all(
			`SELECT * FROM "${entity.plural}" ${whereSql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
			[...args, limit, offset],
		)
		let sliced = rows
		if (filterAfterPage && params.filter !== undefined && params.filter !== "") {
			const compiled = compileFilter(params.filter, filterable, columns, numeric)
			const ids = rows.map((row) => row.id).filter((id): id is string => typeof id === "string")
			if (ids.length === 0) sliced = []
			else {
				const filtered = await this.db.all(
					`SELECT * FROM "${entity.plural}" WHERE id IN (${ids.map(() => "?").join(", ")}) AND (${compiled.sql})`,
					[...ids, ...compiled.args],
				)
				const keep = new Set(filtered.map((row) => String(row.id)))
				sliced = rows.filter((row) => keep.has(String(row.id)))
			}
		}
		const items = sliced.map((row) => project(row, params.select, selectable, columns))
		const hasMore = offset + items.length < count
		const last = items.at(-1)
		return {
			count,
			hasMore,
			items,
			limit,
			nextCursor: hasMore && last !== undefined ? encodeCursor(String(last.id)) : null,
			page,
		}
	}

	async insert(entity: Entity, row: Row): Promise<Row> {
		const cols = Object.keys(row)
		await this.db.run(
			`INSERT INTO "${entity.plural}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
			cols.map((c) => asSql(row[c])),
		)
		if (!hasDefect(this.world, "stale-parent")) await this.recountParents(entity, row)
		return row
	}

	async update(entity: Entity, orgId: string, id: string, patch: Row): Promise<Row | null> {
		const current = await this.get(entity, orgId, id)
		if (current === null) return null
		const next = { ...current, ...patch, updated_at: Date.now() }
		const cols = hasDefect(this.world, "clobber-patch")
			? Object.keys(next).filter((key) => key !== "id")
			: [...Object.keys(patch), "updated_at"]
		await this.db.run(
			`UPDATE "${entity.plural}" SET ${cols.map((c) => `"${c}" = ?`).join(", ")} WHERE id = ? AND org_id = ?`,
			[...cols.map((c) => asSql(next[c])), id, orgId],
		)
		return next
	}

	async remove(entity: Entity, orgId: string, id: string): Promise<boolean> {
		const current = await this.get(entity, orgId, id)
		if (current === null) return false
		if (entity.softDelete === true) {
			await this.db.run(
				`UPDATE "${entity.plural}" SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
				[Date.now(), Date.now(), id, orgId],
			)
		} else {
			await this.db.run(`DELETE FROM "${entity.plural}" WHERE id = ? AND org_id = ?`, [id, orgId])
		}
		if (!hasDefect(this.world, "stale-parent")) await this.recountParents(entity, current)
		return true
	}

	async findIdempotent(key: string): Promise<Row | null> {
		const rows = await this.db.all(`SELECT record FROM idempotency WHERE key = ?`, [key])
		const raw = rows[0]?.record
		return typeof raw === "string" ? (JSON.parse(raw) as Row) : null
	}

	async saveIdempotent(key: string, record: Row): Promise<void> {
		await this.db.run(`INSERT OR REPLACE INTO idempotency (key, record) VALUES (?, ?)`, [
			key,
			JSON.stringify(record),
		])
	}

	async saveGrant(grant: Grant): Promise<void> {
		await this.db.run(
			`INSERT OR REPLACE INTO invites
				(grant_id, token, entity, item_id, owner_org, grantee_key, accepted)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				grant.grantId,
				grant.token,
				grant.entity,
				grant.itemId,
				grant.ownerOrg,
				grant.granteeKey,
				grant.accepted ? 1 : 0,
			],
		)
	}

	async getGrant(grantId: string): Promise<Grant | null> {
		const rows = await this.db.all(`SELECT * FROM invites WHERE grant_id = ?`, [grantId])
		return rows[0] === undefined ? null : grantFromRow(rows[0])
	}

	async getGrantByToken(token: string): Promise<Grant | null> {
		const rows = await this.db.all(`SELECT * FROM invites WHERE token = ?`, [token])
		return rows[0] === undefined ? null : grantFromRow(rows[0])
	}

	async findAcceptedGrant(entity: string, itemId: string, granteeKey: string): Promise<Grant | null> {
		const rows = await this.db.all(
			`SELECT * FROM invites WHERE entity = ? AND item_id = ? AND grantee_key = ? AND accepted = 1`,
			[entity, itemId, granteeKey],
		)
		return rows[0] === undefined ? null : grantFromRow(rows[0])
	}

	async deleteGrant(grantId: string): Promise<boolean> {
		const current = await this.getGrant(grantId)
		if (current === null) return false
		await this.db.run(`DELETE FROM invites WHERE grant_id = ?`, [grantId])
		return true
	}

	async recountParents(entity: Entity, row: Row): Promise<void> {
		if (entity.parent === undefined) return
		const parent = entityByName(this.world, entity.parent)
		const parentId = row[`${parent.name}_id`]
		if (typeof parentId !== "string") return
		for (const derived of parent.derived ?? []) {
			if (derived.from !== entity.name || derived.op !== "count") continue
			const extra = entity.softDelete === true ? ` AND deleted_at IS NULL` : ""
			const counted = await this.db.all(
				`SELECT COUNT(*) AS n FROM "${entity.plural}" WHERE "${parent.name}_id" = ?${extra}`,
				[parentId],
			)
			await this.db.run(
				`UPDATE "${parent.plural}" SET "${derived.name}" = ?, updated_at = ? WHERE id = ?`,
				[Number(counted[0]?.n ?? 0), Date.now(), parentId],
			)
		}
	}
}

function asSql(value: unknown): string | number | null {
	if (value === null || value === undefined) return null
	if (typeof value === "number") return value
	if (typeof value === "boolean") return value ? 1 : 0
	return String(value)
}

function grantFromRow(row: Row): Grant {
	return {
		accepted: Number(row.accepted) === 1,
		entity: String(row.entity),
		grantId: String(row.grant_id),
		granteeKey: String(row.grantee_key),
		itemId: String(row.item_id),
		ownerOrg: String(row.owner_org),
		token: String(row.token),
	}
}

function encodeCursor(id: string): string {
	const json = JSON.stringify({ id })
	const bytes = new TextEncoder().encode(json)
	let bin = ""
	for (const byte of bytes) bin += String.fromCharCode(byte)
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

function decodeCursor(cursor: string): string {
	try {
		const pad = cursor.replaceAll("-", "+").replaceAll("_", "/")
		const padded = pad + "=".repeat((4 - (pad.length % 4)) % 4)
		const bin = atob(padded)
		const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { id?: string }
		if (typeof parsed.id !== "string") throw new Error("missing")
		return parsed.id
	} catch {
		throw new QueryError("cursor is not a value produced by this API")
	}
}
