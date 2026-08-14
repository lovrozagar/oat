import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { compileFilter, compileOrder, project, QueryError } from "./query.ts"

export type Row = Record<string, unknown>

export interface Driver {
	exec(sql: string): Promise<void>
	run(sql: string, args: Array<string | number | null>): Promise<void>
	all(sql: string, args: Array<string | number | null>): Promise<Row[]>
}

const FILTERABLE = ["id", "org_id", "title", "slug", "status", "position", "created_at", "updated_at"]
const SORTABLE = ["id", "title", "slug", "status", "position", "created_at", "updated_at"]
const SEARCHABLE = ["title", "slug", "body"]
const SELECTABLE = [
	"id",
	"org_id",
	"title",
	"slug",
	"status",
	"body",
	"position",
	"comment_count",
	"created_at",
	"updated_at",
	"deleted_at",
]

const COMMENT_FILTERABLE = ["id", "org_id", "article_id", "body", "author", "kind", "created_at", "updated_at"]
const COMMENT_SORTABLE = ["id", "kind", "created_at", "updated_at"]
const COMMENT_SEARCHABLE = ["body", "author"]
const COMMENT_SELECTABLE = COMMENT_FILTERABLE

export const CAPABILITY = {
	filterable: FILTERABLE,
	maxLimit: 100,
	searchable: SEARCHABLE,
	selectable: SELECTABLE,
	sortable: SORTABLE,
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

export interface ListResult {
	items: Row[]
	count: number
	hasMore: boolean
	nextCursor: string | null
	page: number
	limit: number
}

export class Store {
	db: Driver
	constructor(db: Driver) {
		this.db = db
	}

	static async open(db: Driver): Promise<Store> {
		const schema = await readFile(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8")
		await db.exec(schema)
		await migrate(db)
		return new Store(db)
	}

	async get(orgId: string, id: string): Promise<Row | null> {
		const rows = await this.db.all(
			`SELECT * FROM articles WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
			[id, orgId],
		)
		return rows[0] ?? null
	}

	/** Exists in another tenant — used to return 404 rather than 403. */
	async existsElsewhere(id: string, orgId: string): Promise<boolean> {
		const rows = await this.db.all(
			`SELECT 1 AS n FROM articles WHERE id = ? AND org_id != ? AND deleted_at IS NULL`,
			[id, orgId],
		)
		return rows.length > 0
	}

	async list(orgId: string, params: ListParams): Promise<ListResult> {
		const where: string[] = [`org_id = ?`, `deleted_at IS NULL`]
		const args: Array<string | number | null> = [orgId]

		if (params.filter !== undefined && params.filter !== "") {
			const compiled = compileFilter(params.filter, FILTERABLE)
			where.push(compiled.sql)
			args.push(...compiled.args)
		}

		if (params.q !== undefined && params.q !== "") {
			const needle = `%${params.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
			where.push(
				`(${SEARCHABLE.map((f) => `LOWER("${f}") LIKE LOWER(?) ESCAPE '\\'`).join(" OR ")})`,
			)
			for (const _ of SEARCHABLE) args.push(needle)
		}

		const whereSql = `WHERE ${where.join(" AND ")}`
		const counted = await this.db.all(`SELECT COUNT(*) AS n FROM articles ${whereSql}`, args)
		const count = Number(counted[0]?.n ?? 0)

		const order = compileOrder(params.order ?? "created_at.desc", SORTABLE, "id")
		const requested = params.limit ?? 20
		const limit = Math.max(1, Math.min(requested, CAPABILITY.maxLimit))
		const page = Math.max(params.page ?? 1, 1)
		let offset = (page - 1) * limit
		if (params.cursor !== undefined && params.cursor !== "") {
			const after = decodeCursor(params.cursor)
			const idx = await this.db.all(
				`SELECT id FROM articles ${whereSql} ORDER BY ${order.sql}`,
				args,
			)
			const at = idx.findIndex((row) => String(row.id) === after)
			offset = at === -1 ? 0 : at + 1
		}

		const rows = await this.db.all(
			`SELECT * FROM articles ${whereSql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
			[...args, limit, offset],
		)
		const items = rows.map((row) => project(row, params.select, SELECTABLE))
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

	async insert(row: Row): Promise<Row> {
		const cols = Object.keys(row)
		await this.db.run(
			`INSERT INTO articles (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
			cols.map((c) => asSql(row[c])),
		)
		return row
	}

	async update(orgId: string, id: string, patch: Row): Promise<Row | null> {
		const current = await this.get(orgId, id)
		if (current === null) return null
		/* Only the columns the caller named. Writing the whole row back is read-modify-write:
		 * two concurrent PATCHes to different fields, and the later write restores the earlier
		 * field's old value. That is silent on an in-process store and shows up on D1. */
		const cols = [...Object.keys(patch), "updated_at"]
		const next = { ...current, ...patch, updated_at: Date.now() }
		await this.db.run(
			`UPDATE articles SET ${cols.map((c) => `"${c}" = ?`).join(", ")} WHERE id = ? AND org_id = ?`,
			[...cols.map((c) => asSql(next[c])), id, orgId],
		)
		return next
	}

	async softDelete(orgId: string, id: string): Promise<boolean> {
		const current = await this.get(orgId, id)
		if (current === null) return false
		await this.db.run(
			`UPDATE articles SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
			[Date.now(), Date.now(), id, orgId],
		)
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

	async getComment(orgId: string, articleId: string, id: string): Promise<Row | null> {
		const rows = await this.db.all(
			`SELECT * FROM comments WHERE id = ? AND article_id = ? AND org_id = ?`,
			[id, articleId, orgId],
		)
		return rows[0] ?? null
	}

	async listComments(orgId: string, articleId: string, params: ListParams): Promise<ListResult> {
		const where: string[] = [`org_id = ?`, `article_id = ?`]
		const args: Array<string | number | null> = [orgId, articleId]
		if (params.filter !== undefined && params.filter !== "") {
			const compiled = compileFilter(params.filter, COMMENT_FILTERABLE)
			where.push(compiled.sql)
			args.push(...compiled.args)
		}
		if (params.q !== undefined && params.q !== "") {
			const needle = `%${params.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
			where.push(`(${COMMENT_SEARCHABLE.map((f) => `LOWER("${f}") LIKE LOWER(?) ESCAPE '\\'`).join(" OR ")})`)
			for (const _ of COMMENT_SEARCHABLE) args.push(needle)
		}
		const whereSql = `WHERE ${where.join(" AND ")}`
		const counted = await this.db.all(`SELECT COUNT(*) AS n FROM comments ${whereSql}`, args)
		const count = Number(counted[0]?.n ?? 0)
		const order = compileOrder(params.order ?? "created_at.desc", COMMENT_SORTABLE, "id")
		const requested = params.limit ?? 20
		const limit = Math.max(1, Math.min(requested, CAPABILITY.maxLimit))
		const page = Math.max(params.page ?? 1, 1)
		let offset = (page - 1) * limit
		if (params.cursor !== undefined && params.cursor !== "") {
			const after = decodeCursor(params.cursor)
			const idx = await this.db.all(
				`SELECT id FROM comments ${whereSql} ORDER BY ${order.sql}`,
				args,
			)
			const at = idx.findIndex((row) => String(row.id) === after)
			offset = at === -1 ? 0 : at + 1
		}
		const rows = await this.db.all(
			`SELECT * FROM comments ${whereSql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
			[...args, limit, offset],
		)
		const items = rows.map((row) => project(row, params.select, COMMENT_SELECTABLE))
		const last = items.at(-1)
		const hasMore = offset + items.length < count
		return {
			count,
			hasMore,
			items,
			limit,
			nextCursor: hasMore && last !== undefined ? encodeCursor(String(last.id)) : null,
			page,
		}
	}

	async insertComment(row: Row): Promise<Row> {
		const cols = Object.keys(row)
		await this.db.run(
			`INSERT INTO comments (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
			cols.map((c) => asSql(row[c])),
		)
		await this.recountComments(String(row.org_id), String(row.article_id))
		return row
	}

	async updateComment(orgId: string, articleId: string, id: string, patch: Row): Promise<Row | null> {
		const current = await this.getComment(orgId, articleId, id)
		if (current === null) return null
		const cols = [...Object.keys(patch), "updated_at"]
		const next = { ...current, ...patch, updated_at: Date.now() }
		await this.db.run(
			`UPDATE comments SET ${cols.map((c) => `"${c}" = ?`).join(", ")} WHERE id = ? AND article_id = ? AND org_id = ?`,
			[...cols.map((c) => asSql(next[c])), id, articleId, orgId],
		)
		return next
	}

	async deleteComment(orgId: string, articleId: string, id: string): Promise<boolean> {
		const current = await this.getComment(orgId, articleId, id)
		if (current === null) return false
		await this.db.run(
			`DELETE FROM comments WHERE id = ? AND article_id = ? AND org_id = ?`,
			[id, articleId, orgId],
		)
		await this.recountComments(orgId, articleId)
		return true
	}

	async recountComments(orgId: string, articleId: string): Promise<void> {
		if (process.env.LAB_BUG === "stale-comments") return
		const counted = await this.db.all(
			`SELECT COUNT(*) AS n FROM comments WHERE org_id = ? AND article_id = ?`,
			[orgId, articleId],
		)
		await this.db.run(
			`UPDATE articles SET comment_count = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
			[Number(counted[0]?.n ?? 0), Date.now(), articleId, orgId],
		)
	}
}

async function migrate(db: Driver): Promise<void> {
	try {
		await db.exec("ALTER TABLE articles ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0")
	} catch {
		/* column already exists on D1 / an older sqlite file */
	}
	await db.exec(
		`CREATE TABLE IF NOT EXISTS comments (
			id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL,
			article_id TEXT NOT NULL,
			body TEXT NOT NULL,
			author TEXT,
			kind TEXT NOT NULL DEFAULT 'note',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	)
	for (const sql of [
		"ALTER TABLE comments ADD COLUMN author TEXT",
		"ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'",
	]) {
		try {
			await db.exec(sql)
		} catch {
			/* already present */
		}
	}
	await db.exec(`CREATE INDEX IF NOT EXISTS comments_article ON comments (org_id, article_id, id)`)
}

export async function ensureIdempotencyTable(db: Driver): Promise<void> {
	await db.exec(
		`CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, record TEXT NOT NULL)`,
	)
}

function asSql(value: unknown): string | number | null {
	if (value === null || value === undefined) return null
	if (typeof value === "number") return value
	if (typeof value === "boolean") return value ? 1 : 0
	return String(value)
}

function encodeCursor(id: string): string {
	return Buffer.from(JSON.stringify({ id }), "utf8").toString("base64url")
}

function decodeCursor(cursor: string): string {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: string }
		if (typeof parsed.id !== "string") throw new Error("missing")
		return parsed.id
	} catch {
		throw new QueryError("cursor is not a value produced by this API")
	}
}
