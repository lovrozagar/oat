import { compileFilter, compileOrder, project, QueryError, type Compiled, type FilterScope } from "./query.ts"
import type { Driver, Row } from "./store.ts"
import { allColumns, hasDefect, numericFields, parentIdField, type Entity, type World } from "./types.ts"

export interface ListParams {
	filter?: string | undefined
	order?: string | undefined
	select?: string | undefined
	q?: string | undefined
	limit?: number | undefined
	page?: number | undefined
	cursor?: string | undefined
}

export interface ListPage {
	items: Row[]
	count: number
	hasMore: boolean
	nextCursor: string | null
	page: number
	limit: number
}

/** One list request against one world: the store's driver and defects, the entity, its scope. */
/** What a list call asks for: the parent ids it is scoped under, and its query parameters. */
export interface ListQuery {
	scope: Record<string, string>
	params: ListParams
}

interface ListRequest {
	db: Driver
	world: World
	entity: Entity
	params: ListParams
}

interface Fields {
	filter: FilterScope
	sortable: string[]
	searchable: string[]
	selectable: string[]
}

interface Where {
	sql: string
	args: Array<string | number | null>
}

export async function listEntity(
	store: { db: Driver; world: World },
	entity: Entity,
	{ params, scope }: ListQuery,
): Promise<ListPage> {
	const request: ListRequest = { db: store.db, entity, params, world: store.world }
	const fields = fieldsOf(entity)
	const where = whereOf(request, fields, scope)
	const counted = await request.db.all(`SELECT COUNT(*) AS n FROM "${entity.plural}" ${where.sql}`, where.args)
	const count = Number(counted[0]?.["n"] ?? 0)
	const compiledOrder = compileOrder(params.order ?? "created_at.desc", {
		columns: fields.filter.columns,
		sortable: fields.sortable,
		tiebreak: "id",
	})
	const order = hasDefect(request.world, "drop-sort")
		? { args: [] as Array<string | number | null>, sql: `"created_at" DESC, "id" ASC` }
		: compiledOrder
	const limit = limitOf(request, entity.maxLimit ?? 100)
	const page = Math.max(params.page ?? 1, 1)
	const offset = await offsetOf(request, { limit, order, page, where })
	const rows = await request.db.all(
		`SELECT * FROM "${entity.plural}" ${where.sql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
		[...where.args, limit, offset],
	)
	const items = projectItems(request, fields, await filterAfterPage(request, fields, rows))
	const hasMore = hasDefect(request.world, "lie-has-more") ? false : offset + items.length < count
	const last = items.at(-1)
	return {
		count: hasDefect(request.world, "lie-count") ? 0 : count,
		hasMore,
		items,
		limit,
		nextCursor: hasMore && last !== undefined ? encodeCursor(String(last["id"])) : null,
		page,
	}
}

function fieldsOf(entity: Entity): Fields {
	const flagged = (flag: "filterable" | "sortable" | "searchable"): string[] =>
		entity.fields.filter((f) => f[flag] === true).map((f) => f.name)
	return {
		filter: {
			columns: new Set(allColumns(entity)),
			filterable: ["id", "org_id", ...flagged("filterable"), "created_at", "updated_at"],
			numeric: new Set(numericFields(entity)),
		},
		searchable: flagged("searchable"),
		selectable: allColumns(entity),
		sortable: ["id", ...flagged("sortable"), "created_at", "updated_at"],
	}
}

function hasFilter(params: ListParams): params is ListParams & { filter: string } {
	return params.filter !== undefined && params.filter !== ""
}

function whereOf(request: ListRequest, fields: Fields, scope: Record<string, string>): Where {
	const { entity, params, world } = request
	const where: string[] = []
	const args: Array<string | number | null> = []
	if (!(hasDefect(world, "filter-bypass-tenant") && hasFilter(params))) {
		where.push(`org_id = ?`)
		args.push(scope["org_id"] ?? "")
	}
	if (entity.softDelete === true && !hasDefect(world, "list-tombstone")) {
		where.push(`deleted_at IS NULL`)
	}
	const parent = parentIdField(entity)
	if (parent !== null && scope[parent] !== undefined) {
		where.push(`"${parent}" = ?`)
		args.push(scope[parent] as string)
	}
	const filter = filterClause(request, fields)
	if (filter !== null) {
		where.push(filter.sql)
		args.push(...filter.args)
	}
	const search = searchClause(request, fields)
	if (search !== null) {
		where.push(search.sql)
		args.push(...search.args)
	}
	if (where.length === 0) where.push("1 = 1")
	return { args, sql: `WHERE ${where.join(" AND ")}` }
}

/** The filter's clause, or null when there is none or a defect applies it later or not at all. */
function filterClause(request: ListRequest, fields: Fields): Compiled | null {
	const { params, world } = request
	if (!hasFilter(params)) return null
	const compiled = compileFilter(params.filter, fields.filter, {
		acceptUnknown: hasDefect(world, "accept-unknown-filter"),
		andAsOr: hasDefect(world, "and-as-or"),
		ignoreNeq: hasDefect(world, "ignore-neq"),
		orAsAnd: hasDefect(world, "or-as-and"),
		textCompare: hasDefect(world, "text-compare"),
		unescapeLike: hasDefect(world, "unescape-like"),
	})
	/* Parsed either way so unknown fields still 400. */
	if (hasDefect(world, "drop-filter") || hasDefect(world, "filter-after-page")) return null
	return compiled
}

function searchClause(request: ListRequest, fields: Fields): Compiled | null {
	const { q } = request.params
	const { searchable } = fields
	if (q === undefined || q === "" || searchable.length === 0 || hasDefect(request.world, "drop-search")) return null
	const needle = `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
	return {
		args: searchable.map(() => needle),
		sql: `(${searchable.map((f) => `LOWER("${f}") LIKE LOWER(?) ESCAPE '\\'`).join(" OR ")})`,
	}
}

function limitOf(request: ListRequest, maxLimit: number): number {
	const requested = request.params.limit ?? 20
	if (hasDefect(request.world, "ignore-limit")) return 100_000
	if (hasDefect(request.world, "ignore-max-limit")) return Math.max(1, requested)
	return Math.max(1, Math.min(requested, maxLimit))
}

async function offsetOf(
	request: ListRequest,
	at: { limit: number; order: Compiled; page: number; where: Where },
): Promise<number> {
	const { cursor } = request.params
	if (hasDefect(request.world, "ignore-page")) return 0
	if (cursor === undefined || cursor === "" || hasDefect(request.world, "ignore-cursor")) {
		return (at.page - 1) * at.limit
	}
	const after = decodeCursor(cursor)
	const idx = await request.db.all(
		`SELECT id FROM "${request.entity.plural}" ${at.where.sql} ORDER BY ${at.order.sql}`,
		at.where.args,
	)
	const index = idx.findIndex((row) => String(row["id"]) === after)
	return index === -1 ? 0 : index + 1
}

/** The filter-after-page defect: the page is read unfiltered, then the filter drops rows from it. */
async function filterAfterPage(request: ListRequest, fields: Fields, rows: Row[]): Promise<Row[]> {
	const { params } = request
	if (!hasDefect(request.world, "filter-after-page") || !hasFilter(params)) return rows
	const compiled = compileFilter(params.filter, fields.filter)
	const ids = rows.map((row) => row["id"]).filter((id): id is string => typeof id === "string")
	if (ids.length === 0) return []
	const filtered = await request.db.all(
		`SELECT * FROM "${request.entity.plural}" WHERE id IN (${ids.map(() => "?").join(", ")}) AND (${compiled.sql})`,
		[...ids, ...compiled.args],
	)
	const keep = new Set(filtered.map((row) => String(row["id"])))
	return rows.filter((row) => keep.has(String(row["id"])))
}

function projectItems(request: ListRequest, fields: Fields, rows: Row[]): Row[] {
	const { select } = request.params
	const { columns } = fields.filter
	if (!hasDefect(request.world, "drop-select")) {
		return rows.map((row) => project(row, select, { columns, selectable: fields.selectable }))
	}
	/* Validate the projection so unknown fields still 400, then ignore it. */
	if (select !== undefined && select !== "") project({}, select, { columns, selectable: fields.selectable })
	return rows.map((row) => ({ ...row }))
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
