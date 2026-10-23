import { listEntity, type ListPage, type ListParams } from "./list.ts"
import { schemaStatements } from "./schema.ts"
import { entityByName, hasDefect, type Entity, type World } from "./types.ts"

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

/** One row of an entity, named by the org that owns it and its id. */
export interface RowRef {
	orgId: string
	id: string
}

export interface Driver {
	exec(sql: string): Promise<void>
	run(sql: string, args: Array<string | number | null>): Promise<void>
	all(sql: string, args: Array<string | number | null>): Promise<Row[]>
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
			const rows = await this.db.all(`SELECT * FROM "${entity.plural}" WHERE id = ?${extra}`, [id])
			return rows[0] ?? null
		}
		const rows = await this.db.all(`SELECT * FROM "${entity.plural}" WHERE id = ? AND org_id = ?${extra}`, [id, orgId])
		return rows[0] ?? null
	}

	async existsElsewhere(entity: Entity, id: string, orgId: string): Promise<boolean> {
		const extra = entity.softDelete === true ? ` AND deleted_at IS NULL` : ""
		const rows = await this.db.all(`SELECT 1 AS n FROM "${entity.plural}" WHERE id = ? AND org_id != ?${extra}`, [
			id,
			orgId,
		])
		return rows.length > 0
	}

	list(entity: Entity, scope: Record<string, string>, params: ListParams): Promise<ListPage> {
		return listEntity(this, entity, { params, scope })
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

	async update(entity: Entity, { id, orgId }: RowRef, patch: Row): Promise<Row | null> {
		const current = await this.get(entity, orgId, id)
		if (current === null) return null
		const next: Row = { ...current, ...patch, updated_at: Date.now() }
		const extra: string[] = []
		if (hasDefect(this.world, "widen-patch") && !Object.hasOwn(patch, "kind") && Object.hasOwn(current, "kind")) {
			next["kind"] = current["kind"] === "red" ? "blue" : "red"
			extra.push("kind")
		}
		const cols = hasDefect(this.world, "clobber-patch")
			? Object.keys(next).filter((key) => key !== "id")
			: [...Object.keys(patch), "updated_at", ...extra]
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
			await this.db.run(`UPDATE "${entity.plural}" SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`, [
				Date.now(),
				Date.now(),
				id,
				orgId,
			])
		} else {
			await this.db.run(`DELETE FROM "${entity.plural}" WHERE id = ? AND org_id = ?`, [id, orgId])
		}
		if (!hasDefect(this.world, "stale-parent")) await this.recountParents(entity, current)
		return true
	}

	async findIdempotent(key: string): Promise<Row | null> {
		const rows = await this.db.all(`SELECT record FROM idempotency WHERE key = ?`, [key])
		const raw = rows[0]?.["record"]
		return typeof raw === "string" ? (JSON.parse(raw) as Row) : null
	}

	async saveIdempotent(key: string, record: Row): Promise<void> {
		await this.db.run(`INSERT OR REPLACE INTO idempotency (key, record) VALUES (?, ?)`, [key, JSON.stringify(record)])
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
		if (!hasDefect(this.world, "revoke-noop")) {
			await this.db.run(`DELETE FROM invites WHERE grant_id = ?`, [grantId])
		}
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
			await this.db.run(`UPDATE "${parent.plural}" SET "${derived.name}" = ?, updated_at = ? WHERE id = ?`, [
				Number(counted[0]?.["n"] ?? 0),
				Date.now(),
				parentId,
			])
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
		accepted: Number(row["accepted"]) === 1,
		entity: String(row["entity"]),
		grantId: String(row["grant_id"]),
		granteeKey: String(row["grantee_key"]),
		itemId: String(row["item_id"]),
		ownerOrg: String(row["owner_org"]),
		token: String(row["token"]),
	}
}
