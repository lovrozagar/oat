/**
 * The reference backend's HTTP layer — one implementation, any store.
 *
 * Routing, auth, tenancy, validation and the defect behaviours that live above storage are
 * written once here. Each engine supplies only a `Store`, so a defect is defined in one place
 * and exercised identically on every backend; when two engines then disagree about what that
 * defect *does*, the disagreement is real rather than an artefact of two implementations
 * drifting apart.
 *
 * Backends: `createMemoryServer` (no dependencies), `createSqliteServer` (`node:sqlite`),
 * `createD1Server` (Cloudflare D1 over HTTP),
 * `createPostgresServer` (a reachable server). Every store is imported lazily — a static import
 * would load one engine's driver for all of them, and an optional runtime such as `node:sqlite`
 * would take down paths that never touch it.
 *
 * This is a test fixture. It is excluded from the published package; oat itself never talks to
 * a database.
 */

import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { DefectSet as Defects, type DefectSet } from "./defects.ts"
import { type EntityDef, type FieldDef, fieldsWhere, shapedEntities, writableFields } from "./model.ts"
import { type Dialect, DIALECTS, toCanonicalFilter } from "./dialect.ts"
import { type ListingRequest, runListing } from "./listing.ts"
import { DEFAULT_CONVENTIONS, type FilterNode, type QueryConventions, and } from "./query.ts"
import { type ReferenceShape, shapeNamed, shapedDialect } from "./shapes.ts"
import { buildSpec, buildUntaggedSpec } from "./spec.ts"
import { SqlError, type Row, type Store } from "./store-api.ts"

interface Principal {
	key: string
	token: string
	projectId: string
	/** Higher can do everything a lower rank can. Viewer 0, member 1, owner 2. */
	rank: number
}

const PRINCIPALS: Principal[] = [
	{ key: "key_alpha", projectId: "proj_alpha", rank: 2, token: "tok_alpha" },
	{ key: "key_beta", projectId: "proj_beta", rank: 2, token: "tok_beta" },
	{ key: "key_alpha_member", projectId: "proj_alpha", rank: 1, token: "tok_alpha_member" },
	{ key: "key_alpha_viewer", projectId: "proj_alpha", rank: 0, token: "tok_alpha_viewer" },
]

const TENANT_FIELD = "project_id"

/** Path parameters, typed: an integer identifier is a number from the moment it is parsed. */
type Scope = Record<string, string | number>

/** 48 KiB per record: six of them make one listing page larger than 256 KiB. */
const PADDING = "oat reference padding · ".repeat(2100).slice(0, 49_152)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly errorKey: string,
		message: string,
	) {
		super(message)
	}
}

/* ------------------------------------------------------------------ validation */

function validateBody(
	entity: EntityDef,
	body: unknown,
	mode: "create" | "update" | "replace",
	defects: DefectSet,
): Row {
	const phase = mode === "create" ? "create" : "update"
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "invalid_input", "request body must be a JSON object")
	}
	const input = body as Row
	const allowed = new Map(writableFields(entity, phase).map((f) => [f.name, f]))

	for (const key of Object.keys(input)) {
		if (allowed.has(key)) continue
		const known = entity.fields.find((f) => f.name === key)
		if (known !== undefined && (known.immutable === true || known.generated === true)) {
			if (defects.has("IMMUTABLE_WRITABLE")) {
				allowed.set(key, known)
				continue
			}
			throw new HttpError(400, "invalid_input", `field "${key}" is not writable`)
		}
		throw new HttpError(400, "invalid_input", `unknown field "${key}"`)
	}

	/* A create, and a replacing update, must carry every required field. */
	if (mode !== "update") {
		for (const field of allowed.values()) {
			if (field.required === true && input[field.name] === undefined && !defects.has("REQUIRED_NOT_VALIDATED")) {
				throw new HttpError(400, "invalid_input", `field "${field.name}" is required`)
			}
		}
	}

	const out: Row = {}
	for (const [key, value] of Object.entries(input)) {
		const field = allowed.get(key)
		if (field === undefined) continue
		out[key] = coerceField(field, value, defects)
	}
	return out
}

function coerceField(field: FieldDef, value: unknown, defects: DefectSet): unknown {
	if (value === null) {
		if (field.nullable !== true) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" is not nullable`)
		}
		return null
	}
	if (field.type === "integer" || field.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be a number`)
		}
		if (field.type === "integer" && !Number.isInteger(value)) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be an integer`)
		}
		if (
			(field.minimum !== undefined && value < field.minimum) ||
			(field.maximum !== undefined && value > field.maximum) ||
			(field.multipleOf !== undefined && !Number.isInteger(value / field.multipleOf))
		) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" is out of range`)
		}
		return value
	}
	if (field.type === "array") {
		const allowed = field.items ?? []
		if (
			!Array.isArray(value) ||
			value.length > 5 ||
			value.some((element) => typeof element !== "string" || !allowed.includes(element))
		) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be a list of ${allowed.join(", ")}`)
		}
		return [...value]
	}
	if (field.type === "object") {
		if (field.ref !== "Point" || !isPoint(value)) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be a ${field.ref ?? "object"}`)
		}
		return { x: value.x, y: value.y }
	}
	if (field.type === "boolean") {
		if (typeof value !== "boolean") {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be a boolean`)
		}
		return value
	}
	if (typeof value !== "string") {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be a string`)
	}
	if (field.maxLength !== undefined && value.length > field.maxLength && !defects.has("MAXLENGTH_NOT_VALIDATED")) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" exceeds maxLength`)
	}
	if (field.enum !== undefined && !field.enum.includes(value) && !defects.has("ENUM_NOT_VALIDATED")) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be one of ${field.enum.join(", ")}`)
	}
	if (field.const !== undefined && value !== field.const) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be "${field.const}"`)
	}
	if (field.format === "date-time" && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be an RFC 3339 date-time`)
	}
	if (field.format === "uuid" && !UUID.test(value)) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be a UUID`)
	}
	if (defects.has("STRING_PAYLOAD_MANGLED")) {
		return value.replace(/[^\x20-\x7E]/g, "").trim()
	}
	return value
}

/** The value a field takes when nobody supplied one. */
function emptyValue(field: FieldDef): unknown {
	if (field.nullable === true) return null
	if (field.type === "array") return []
	if (field.type === "boolean") return false
	if (field.type === "integer" || field.type === "number") return 0
	return field.enum?.[0] ?? ""
}

function isPoint(value: unknown): value is { x: number; y: number } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false
	const keys = Object.keys(value)
	const { x, y } = value as { x?: unknown; y?: unknown }
	return keys.length === 2 && Number.isInteger(x) && Number.isInteger(y)
}

/**
 * Reads a form-encoded body into the types the schema declares.
 *
 * A form carries only strings, so a correct backend coerces each field by its declared type —
 * exactly what it would have to do in production.
 */
function formFields(entity: EntityDef, text: string): Row {
	const out: Row = {}
	for (const [key, raw] of new URLSearchParams(text)) {
		const field = entity.fields.find((candidate) => candidate.name === key)
		if (field === undefined) {
			out[key] = raw
			continue
		}
		if (field.type === "array") {
			/* A form repeats the key once per element. */
			out[key] = [...((out[key] as unknown[] | undefined) ?? []), raw]
		} else if (field.type === "integer" || field.type === "number") {
			out[key] = raw.trim() === "" ? raw : Number(raw)
		} else if (field.type === "boolean") {
			out[key] = raw === "true" ? true : raw === "false" ? false : raw
		} else {
			out[key] = raw
		}
	}
	return out
}

/* --------------------------------------------------------------------- routing */

interface Match {
	entity: EntityDef
	scope: Record<string, string>
	itemId: string | null
}

function matchRoute(pathname: string, entities: readonly EntityDef[]): Match | null {
	const segments = pathname.split("/").filter(Boolean)
	for (const entity of entities) {
		for (const [template, isItem] of [
			[entity.itemPath, true],
			[entity.collectionPath, false],
		] as const) {
			const parts = template.split("/").filter(Boolean)
			if (parts.length !== segments.length) continue
			const scope: Record<string, string> = {}
			let ok = true
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i]
				const value = segments[i]
				if (part === undefined || value === undefined) {
					ok = false
					break
				}
				if (part.startsWith("{")) scope[part.slice(1, -1)] = decodeURIComponent(value)
				else if (part !== value) {
					ok = false
					break
				}
			}
			if (!ok) continue
			return { entity, itemId: isItem ? (scope[entity.itemParam] ?? null) : null, scope }
		}
	}
	return null
}

/* ------------------------------------------------------------------- the server */

export interface ReferenceServer {
	server: Server
	url: string
	defects: DefectSet
	close: () => Promise<void>
	principals: Principal[]
	/** Every record currently stored, per entity, for leak accounting. Reads the store directly. */
	snapshot: () => Promise<Record<string, Row[]>>
}

export interface ReferenceOptions {
	defects?: string[]
	untagged?: boolean
	dialect?: string
	/** A correct API shape oat was not written against — by name, or spelled out. */
	shape?: string | ReferenceShape
}

function resolveDialect(name: string | undefined): Dialect {
	const dialect = DIALECTS[name ?? "postgrest"]
	if (dialect === undefined) {
		throw new Error(`unknown dialect "${name}" — expected one of ${Object.keys(DIALECTS).join(", ")}`)
	}
	return dialect
}

/**
 * One server, any store. Defining a defect once and exercising it on every engine is what makes
 * a disagreement between engines meaningful rather than an artefact of two implementations.
 */
export async function createReferenceServer(
	options: ReferenceOptions,
	/* Required, and every caller supplies it by dynamic import: a static import of a storage
	 * module would load that engine's driver for *every* backend, and a missing optional
	 * runtime (node:sqlite behind a flag) would then take down paths that never touch it. */
	createStore: (defects: DefectSet, entities: readonly EntityDef[]) => Promise<Store>,
): Promise<ReferenceServer> {
	const defects = new Defects(options.defects ?? [])
	const shape: ReferenceShape =
		typeof options.shape === "string" ? shapeNamed(options.shape).shape : (options.shape ?? {})
	const dialect = shapedDialect(resolveDialect(options.dialect), shape)
	const entities = shapedEntities(shape)
	const TABLE = entities.find((entity) => entity.name === "table") as EntityDef
	const JOB = entities.find((entity) => entity.name === "job") as EntityDef
	const conventions: QueryConventions = { ...DEFAULT_CONVENTIONS, ...shape.conventions }
	const basePath = shape.basePath ?? ""
	const updateMethod = shape.updateMethod ?? "PATCH"
	const store = await createStore(defects, entities)
	const jobStartedAt = new Map<string, number>()
	/* Snapshot of a collection taken before a write, replayed while STALE_LIST is on. */
	const staleSnapshot = new Map<string, Row[]>()
	/* Entities whose first listing has already been refused, for RATE_LIMIT_STRICTER_THAN_DECLARED. */
	const throttled = new Set<string>()
	/* Idempotency-Key → the record the first request created, so a replay returns it. */
	const idempotent = new Map<string, Row>()
	/* Delivered notifications, per project. */
	const inboxes = new Map<string, Array<{ id: string; message: string }>>()

	/* Identifiers and timestamps are the server's, not the store's: one sequence, so every engine
	 * issues the same ids in the same order. Timestamps derive from it rather than the clock —
	 * wall-clock time makes ordering assertions flaky for reasons unrelated to the backend. */
	let sequence = 0
	const nextId = (entity: EntityDef): string | number => {
		sequence += 1
		const identity = entity.fields.find((field) => field.name === entity.identity)
		if (identity?.type === "integer") return sequence
		if (identity?.format === "uuid") {
			/* Deterministic but unordered, like a real v4: creation order says nothing about id order. */
			const h = createHash("sha1").update(`oat-ref-${sequence}`).digest("hex")
			const variant = "89ab"[Number.parseInt(h[16] ?? "0", 16) % 4]
			return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
		}
		return `${entity.name}_${String(sequence).padStart(6, "0")}`
	}
	const now = (): number => 1_700_000_000_000 + sequence * 1000

	/**
	 * Reads one path identifier as the type its entity declares. A malformed one is a 400 — the
	 * strict validation real frameworks apply before a handler ever runs.
	 */
	function pathId(param: string, raw: string): string | number {
		const owner = entities.find((entity) => entity.itemParam === param)
		const identity = owner?.fields.find((field) => field.name === owner.identity)
		if (identity?.type === "integer") {
			if (!/^[1-9]\d{0,14}$/.test(raw)) throw new HttpError(400, "invalid_input", `"${raw}" is not a valid ${param}`)
			return Number(raw)
		}
		if (identity?.format === "uuid" && !UUID.test(raw)) {
			throw new HttpError(400, "invalid_input", `"${raw}" is not a valid ${param}`)
		}
		return raw
	}

	function typedScope(scope: Record<string, string>): Scope {
		const out: Scope = {}
		for (const [param, raw] of Object.entries(scope)) out[param] = pathId(param, raw)
		return out
	}

	/** A record as it leaves the server: write-only fields never do. */
	function present(entity: EntityDef, record: Row): Row {
		const hidden = entity.fields.filter((field) => field.writeOnly === true)
		if (hidden.length === 0) return decorate(record)
		const out = { ...record }
		for (const field of hidden) delete out[field.name]
		return decorate(out)
	}

	function authenticate(req: IncomingMessage): Principal {
		const header = req.headers.authorization
		if (typeof header !== "string" || !header.startsWith("Bearer ")) {
			throw new HttpError(401, "unauthorized", "missing bearer credential")
		}
		const principal = PRINCIPALS.find((p) => p.token === header.slice(7).trim())
		if (principal === undefined) throw new HttpError(401, "unauthorized", "unrecognised credential")
		return principal
	}

	function assertWrite(principal: Principal, kind: "create" | "update" | "delete"): void {
		/* Viewer cannot write; member cannot delete; owner can do everything. */
		if (kind === "update" && defects.has("ROLE_WRITE_INVERTED")) {
			/* The lattice turned over for updates: the viewer may, the member may not. */
			if (principal.rank === 1) throw new HttpError(403, "forbidden", "role cannot write")
			if (principal.rank === 0) return
		}
		if (kind === "delete" && principal.rank < 2) {
			throw new HttpError(403, "forbidden", "role cannot delete")
		}
		if ((kind === "create" || kind === "update") && principal.rank < 1) {
			throw new HttpError(403, "forbidden", "role cannot write")
		}
	}

	function assertTenant(principal: Principal, scope: Scope): void {
		const projectId = scope.project_id
		if (projectId !== undefined && projectId !== principal.projectId) {
			throw new HttpError(403, "forbidden", "resource belongs to another tenant")
		}
	}

	const tombstoned = (entity: EntityDef, record: Row): boolean =>
		entity.softDeleteField !== undefined && record[entity.softDeleteField] !== null

	/** Walks a record up its parent chain to the owning tenant, driven by the descriptors. */
	async function ownedByTenant(entity: EntityDef, record: Row, principal: Principal): Promise<boolean> {
		if (entity.fields.some((f) => f.name === TENANT_FIELD)) {
			return record[TENANT_FIELD] === principal.projectId
		}
		for (const parentParam of entity.parents) {
			const parentEntity = entities.find((e) => e.itemParam === parentParam)
			if (parentEntity === undefined) continue
			const link = record[parentParam]
			if (typeof link !== "string" && typeof link !== "number") continue
			const parent = await store.byId(parentEntity, link)
			if (parent === null) return false
			return ownedByTenant(parentEntity, parent, principal)
		}
		return false
	}

	/**
	 * Every ancestor named in the path must exist, be live, and belong to the caller — and its own
	 * ancestors must be the ones the path names. Without this, a caller could list or write rows of
	 * another tenant's table by placing that table's id under their own project.
	 */
	async function assertParents(entity: EntityDef, scope: Scope, principal: Principal): Promise<void> {
		for (const param of entity.parents) {
			const parentEntity = entities.find((candidate) => candidate.itemParam === param)
			if (parentEntity === undefined) continue
			const id = scope[param] ?? ""
			const parent = await store.byId(parentEntity, id)
			const linked =
				parent !== null &&
				parentEntity.parents.every(
					(ancestor) => !parentEntity.fields.some((f) => f.name === ancestor) || parent[ancestor] === scope[ancestor],
				)
			/* Under the defect a parent only has to exist: whose it is, and whose path names it, go
			 * unchecked — another tenant's parent id under the caller's own root is let through. */
			const foreignAllowed = defects.has("FOREIGN_PARENT_ACCEPTED") && parent !== null
			if (
				!foreignAllowed &&
				(parent === null ||
					!linked ||
					tombstoned(parentEntity, parent) ||
					!(await ownedByTenant(parentEntity, parent, principal)))
			) {
				throw new HttpError(404, "not_found", `${parentEntity.name} ${id} does not exist`)
			}
		}
	}

	/**
	 * A record is served under the path that names its own parents, and no other — all the way up:
	 * a row's table must itself sit under the project the path names.
	 */
	async function underPath(entity: EntityDef, record: Row, scope: Scope): Promise<boolean> {
		const stored = (param: string): boolean => entity.fields.some((f) => f.name === param)
		for (const param of entity.parents) {
			if (stored(param) && scope[param] !== undefined && record[param] !== scope[param]) return false
		}
		const parentParam = [...entity.parents].reverse().find((param) => entities.some((e) => e.itemParam === param))
		if (parentParam === undefined || !stored(parentParam)) return true
		const parentEntity = entities.find((e) => e.itemParam === parentParam) as EntityDef
		const parent = await store.byId(parentEntity, record[parentParam] as string)
		return parent !== null && underPath(parentEntity, parent, scope)
	}

	/**
	 * Advances started jobs and writes the result back.
	 *
	 * Progress is persisted rather than computed per response, so a filter on `status` and the
	 * body it returns describe the same state. Applied before every job read.
	 */
	async function advanceJobs(): Promise<void> {
		if (defects.has("ASYNC_NEVER_COMPLETES")) return
		for (const [id, startedAt] of jobStartedAt) {
			const ratio = Math.min((Date.now() - startedAt) / 60, 1)
			const progress = Math.floor(ratio * 100)
			const status = ratio >= 1 ? "complete" : progress > 0 ? "running" : "pending"
			const current = await store.byId(JOB, id)
			if (current === null) {
				jobStartedAt.delete(id)
				continue
			}
			if (current.status === status && current.progress === progress) continue
			await store.update(JOB, id, { progress, status })
			if (status === "complete") jobStartedAt.delete(id)
		}
	}

	/**
	 * Rewrites a field in the *collection* projection only.
	 *
	 * Applied where the listing is built, never on the item route, so the two disagree exactly as
	 * a stale denormalised listing would. The value is plausible rather than obviously wrong: a
	 * projection that returned garbage would be caught by schema validation instead.
	 */
	function skewForList(record: Row): Row {
		if (!defects.has("LIST_DETAIL_DISAGREE")) return record
		if (typeof record.name !== "string") return record
		return { ...record, name: `${record.name} (listing)` }
	}

	function decorate(record: Row): Row {
		if (!defects.has("RESPONSE_SCHEMA_DRIFT")) return record
		return { ...record, _internal_revision: 7, _shard: "shard-a" }
	}

	/** The live records of one parent scope — what uniqueness and derived counts range over. */
	async function liveRows(entity: EntityDef, scope: Record<string, unknown>): Promise<Row[]> {
		const constraints: FilterNode[] = Object.entries(scope)
			.filter(([name, value]) => value !== undefined && entity.fields.some((field) => field.name === name))
			.map(([field, value]) => ({
				asText: false,
				field,
				kind: "cmp",
				nullsMatch: false,
				op: "eq",
				value: value as string,
			}))
		const soft = entity.softDeleteField
		const where = and(...constraints, soft === undefined ? null : { field: soft, kind: "isnull", negate: false })
		return store.select(entity, { collation: "binary", order: [], shuffleTies: false, where })
	}

	async function assertUnique(entity: EntityDef, record: Row, exceptId: string | undefined): Promise<void> {
		if (defects.has("UNIQUE_NOT_ENFORCED")) return
		const sets = entity.unique ?? []
		if (sets.length === 0) return
		const scope: Row = {}
		for (const parent of entity.parents) scope[parent] = record[parent]
		scope[TENANT_FIELD] = record[TENANT_FIELD]
		const items = await liveRows(entity, scope)
		for (const set of sets) {
			const collides = items.some((row) => {
				if (exceptId !== undefined && String(row[entity.identity]) === exceptId) return false
				return set.every((col) => JSON.stringify(row[col]) === JSON.stringify(record[col]))
			})
			if (collides) throw new HttpError(409, "conflict", `unique constraint violated (${set.join(", ")})`)
		}
	}

	function withDefaults(entity: EntityDef, input: Row, scope: Scope): Row {
		const record: Row = { ...input }
		record[entity.identity] = nextId(entity)
		for (const parent of entity.parents) {
			if (entity.fields.some((f) => f.name === parent)) record[parent] = scope[parent] ?? null
		}
		record.created_at = now()
		record.updated_at = now()
		if (entity.softDeleteField !== undefined) record[entity.softDeleteField] = null
		/* A server-generated field large enough that one page of records exceeds 256 KiB. */
		if (entity.fields.some((field) => field.name === "padding")) record.padding = PADDING
		for (const field of entity.fields) {
			if (record[field.name] !== undefined) continue
			record[field.name] = emptyValue(field)
		}
		return record
	}

	/** Defaults for a replacing update: every writable field the body leaves out is reset. */
	function replacementDefaults(entity: EntityDef): Row {
		const out: Row = {}
		for (const field of writableFields(entity, "update")) out[field.name] = emptyValue(field)
		return out
	}

	function snapshotKey(entity: EntityDef, scope: Scope): string {
		return `${entity.name}:${scope.project_id ?? ""}:${scope.table_id ?? ""}`
	}

	/**
	 * Keeps a parent's derived count current after a child write.
	 *
	 * This is the behaviour `x-invalidate` promises: a write here changes what a *different*
	 * route serves. Under the defect the promise is published and not kept, which is the common
	 * real failure — a denormalised counter or a cached projection that nobody refreshes.
	 */
	async function refreshParentCount(entity: EntityDef, scope: Scope): Promise<void> {
		if (entity.name !== "row") return
		if (defects.has("PARENT_PROJECTION_STALE")) return
		const table = entities.find((candidate) => candidate.name === "table")
		const tableId = scope.table_id
		if (table === undefined || tableId === undefined) return
		const total = (await liveRows(entity, { table_id: tableId })).length
		await store.update(table, tableId, { row_count: total })
	}

	/**
	 * PATCH without a lock: read the row, yield, then write every column back — the ORM
	 * `save(entity)` pattern. Two concurrent patches to different fields, and the later write
	 * reinstates the earlier field's old value. The yield makes the window observable rather
	 * than dependent on scheduler luck; it runs only under the defect.
	 */
	async function readModifyWrite(entity: EntityDef, id: string | number, patch: Row): Promise<Row | null> {
		const current = await store.byId(entity, id)
		if (current === null) return null
		await new Promise((resolve) => setTimeout(resolve, 15))
		return store.update(entity, id, { ...current, ...patch })
	}

	/**
	 * Records that exist before oat arrives — what every real environment has.
	 *
	 * Names alternate case so binary and case-insensitive collations order them differently, some
	 * descriptions are null, and values repeat, so the data looks like a lived-in collection rather
	 * than a fixture. Written straight to the store: none of it is oat's to clean up.
	 */
	async function prepopulate(perTenant: number): Promise<void> {
		const words = ["apple", "Banana", "cherry", "Date", "elder", "Fig", "grape", "Honeydew", "kiwi", "Lemon"]
		for (const [projectId, count] of [
			["proj_alpha", perTenant],
			["proj_beta", Math.ceil(perTenant / 10)],
		] as const) {
			for (let i = 0; i < count; i++) {
				const word = words[i % words.length] as string
				const name = `${word} ${projectId === "proj_alpha" ? "" : "beta "}${String(i).padStart(4, "0")}`
				const table = withDefaults(
					TABLE,
					{
						description: i % 3 === 0 ? null : `pre-existing ${word.toLowerCase()} record`,
						name,
						position: (i * 7) % 100,
						slug: name.toLowerCase().replace(/\s+/g, "-"),
						status: ["active", "draft", "archived"][i % 3],
					},
					{ project_id: projectId },
				)
				await store.insert(TABLE, table)
				const job = withDefaults(
					JOB,
					{ kind: ["export", "import", "sync"][i % 3], name, note: i % 4 === 0 ? null : word },
					{ project_id: projectId },
				)
				job.status = "complete"
				job.progress = 100
				await store.insert(JOB, job)
			}
		}
	}
	if (shape.prepopulate !== undefined) await prepopulate(shape.prepopulate)

	interface Grant {
		accepted: boolean
		entity: string
		grantId: string
		granteeKey: string
		resourceId: string
		token: string
	}
	const grants = new Map<string, Grant>()

	function canReadViaGrant(entityName: string, id: string, principal: Principal): boolean {
		if (defects.has("INVITE_NEVER_GRANTS")) return false
		for (const grant of grants.values()) {
			if (grant.entity !== entityName || grant.resourceId !== id) continue
			if (grant.granteeKey !== principal.key) continue
			if (grant.accepted) return true
		}
		return false
	}

	async function findItem(
		entity: EntityDef,
		principal: Principal,
		id: string | number,
		scope: Scope,
		purpose: "read" | "write" = "read",
	): Promise<Row> {
		const record = await store.byId(entity, id)
		if (record === null) throw new HttpError(404, "not_found", `${entity.name} ${id} does not exist`)
		/* Writes looked up by id alone: reads stay scoped, so only a write probe can tell. */
		if (purpose === "write" && defects.has("CROSS_TENANT_WRITE")) return record
		/* A record named under somebody else's parents is not this caller's to read, whoever owns it. */
		const inPath = await underPath(entity, record, scope)
		const owned = inPath && (await ownedByTenant(entity, record, principal))
		const granted = inPath && canReadViaGrant(entity.name, String(id), principal)
		/* The leak is a lookup by id alone: no tenant check, and no check of the path either. */
		if (!defects.has("CROSS_TENANT_READ") && !owned && !granted) {
			/* Correct is 404: the same answer an id that never existed would get. Answering 403
			 * here is the defect — the denial is right, but the *status* confirms the record is
			 * real, which is all an attacker enumerating identifiers needs. */
			throw defects.has("EXISTENCE_LEAK_VIA_STATUS")
				? new HttpError(403, "forbidden", `${entity.name} ${id} belongs to another tenant`)
				: new HttpError(404, "not_found", `${entity.name} ${id} does not exist`)
		}
		if (tombstoned(entity, record)) {
			throw new HttpError(404, "not_found", `${entity.name} ${id} has been deleted`)
		}
		return record
	}

	async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost")
		const method = (req.method ?? "GET").toUpperCase()

		/* Mounted under a prefix, the API exists only there. */
		if (basePath !== "") {
			if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
				throw new HttpError(404, "not_found", `no route for ${url.pathname}`)
			}
			url.pathname = url.pathname.slice(basePath.length) || "/"
		}

		if (url.pathname === "/v1/openapi/spec") {
			const context = { entities, shape }
			return send(
				res,
				200,
				options.untagged === true ? buildUntaggedSpec(dialect, context) : buildSpec(dialect, context),
			)
		}

		if (url.pathname === "/v1/auth/token" && method === "POST") {
			const body = await readJson(req)
			const principal = PRINCIPALS.find((p) => p.key === (body as { key?: unknown }).key)
			if (principal === undefined) throw new HttpError(401, "unauthorized", "unknown API key")
			return send(res, 200, {
				access_token: principal.token,
				expires_in: 3600,
				project_id: principal.projectId,
			})
		}

		if (url.pathname.endsWith("/jobs/start") && method === "POST") {
			const principal = authenticate(req)
			const projectId = url.pathname.split("/")[3] ?? ""
			if (projectId !== principal.projectId) {
				throw new HttpError(403, "forbidden", "resource belongs to another tenant")
			}
			requireJson(req, defects)
			const name = ((await readJson(req)) as { name?: unknown }).name
			if (typeof name !== "string" || name === "") {
				throw new HttpError(400, "invalid_input", 'field "name" is required')
			}
			const job = withDefaults(JOB, { name }, { project_id: projectId })
			job.status = "pending"
			job.progress = 0
			if (!defects.has("EFFECT_NOT_APPLIED")) {
				await store.insert(JOB, job)
				jobStartedAt.set(String(job.id), Date.now())
			}
			return send(
				res,
				202,
				defects.has("ASYNC_RECEIPT_MISSING_ID") ? { accepted: true } : { accepted: true, job_id: job.id },
			)
		}

		/* A write whose effect lands elsewhere, later: the message reaches the inbox after a short
		 * delay, the way a queue consumer or a webhook delivery would. x-wait documents it. */
		const notifyMatch = /^\/v1\/projects\/([^/]+)\/notifications$/.exec(url.pathname)
		if (notifyMatch !== null && method === "POST") {
			const principal = authenticate(req)
			const projectId = notifyMatch[1] ?? ""
			if (projectId !== principal.projectId) {
				throw new HttpError(403, "forbidden", "resource belongs to another tenant")
			}
			assertWrite(principal, "create")
			requireJson(req, defects)
			const message = ((await readJson(req)) as { message?: unknown }).message
			if (typeof message !== "string" || message === "" || message.length > 200) {
				throw new HttpError(400, "invalid_input", 'field "message" is required')
			}
			sequence += 1
			const id = `ntf_${String(sequence).padStart(6, "0")}`
			if (!defects.has("SIDE_EFFECT_NEVER_ARRIVES")) {
				setTimeout(() => {
					const inbox = inboxes.get(projectId) ?? []
					inbox.push({ id, message })
					inboxes.set(projectId, inbox)
				}, 40)
			}
			return send(res, 202, { accepted: true, notification_id: id })
		}
		const inboxMatch = /^\/v1\/projects\/([^/]+)\/inbox$/.exec(url.pathname)
		if (inboxMatch !== null && method === "GET") {
			const principal = authenticate(req)
			const projectId = inboxMatch[1] ?? ""
			if (projectId !== principal.projectId) {
				throw new HttpError(403, "forbidden", "resource belongs to another tenant")
			}
			return send(res, 200, { messages: inboxes.get(projectId) ?? [] })
		}

		const inviteMatch = /^\/v1\/projects\/([^/]+)\/tables\/([^/]+)\/invites$/.exec(url.pathname)
		if (inviteMatch !== null && method === "POST") {
			const principal = authenticate(req)
			const projectId = inviteMatch[1] ?? ""
			const tableId = pathId(TABLE.itemParam, inviteMatch[2] ?? "")
			if (projectId !== principal.projectId) {
				throw new HttpError(403, "forbidden", "resource belongs to another tenant")
			}
			assertWrite(principal, "create")
			requireJson(req, defects)
			const key = ((await readJson(req)) as { key?: unknown }).key
			if (typeof key !== "string" || key === "") {
				throw new HttpError(400, "invalid_input", 'field "key" is required')
			}
			if (PRINCIPALS.find((p) => p.key === key) === undefined) {
				throw new HttpError(400, "invalid_input", "unknown invitee key")
			}
			await findItem(TABLE, principal, tableId, { project_id: projectId })
			const grant: Grant = {
				accepted: false,
				entity: "table",
				grantId: `grn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
				granteeKey: key,
				resourceId: String(tableId),
				token: `inv_${Math.random().toString(36).slice(2, 12)}`,
			}
			grants.set(grant.grantId, grant)
			return send(res, 201, { grant_id: grant.grantId, token: grant.token })
		}

		const acceptMatch = /^\/v1\/invites\/([^/]+)\/accept$/.exec(url.pathname)
		if (acceptMatch !== null && method === "POST") {
			const principal = authenticate(req)
			const token = acceptMatch[1] ?? ""
			const grant = [...grants.values()].find((item) => item.token === token)
			if (grant === undefined) throw new HttpError(404, "not_found", "invite not found")
			if (grant.granteeKey !== principal.key) {
				throw new HttpError(403, "forbidden", "invite is not for this principal")
			}
			grant.accepted = true
			return send(res, 200, { accepted: true })
		}

		const revokeMatch = /^\/v1\/projects\/([^/]+)\/tables\/([^/]+)\/grants\/([^/]+)$/.exec(url.pathname)
		if (revokeMatch !== null && method === "DELETE") {
			const principal = authenticate(req)
			const projectId = revokeMatch[1] ?? ""
			const tableId = String(pathId(TABLE.itemParam, revokeMatch[2] ?? ""))
			const grantId = revokeMatch[3] ?? ""
			if (projectId !== principal.projectId) {
				throw new HttpError(403, "forbidden", "resource belongs to another tenant")
			}
			assertWrite(principal, "delete")
			const grant = grants.get(grantId)
			if (grant === undefined || grant.resourceId !== tableId) {
				throw new HttpError(404, "not_found", "grant not found")
			}
			if (!defects.has("REVOKE_IGNORED")) grants.delete(grantId)
			return send(res, 200, { revoked: true })
		}

		const match = matchRoute(url.pathname, entities)
		if (match === null) throw new HttpError(404, "not_found", `no route for ${url.pathname}`)

		const principal = authenticate(req)
		const { entity } = match
		const scope = typedScope(match.scope)
		const itemId = match.itemId === null ? null : (scope[entity.itemParam] ?? null)
		/* Item GET may be a delegated read — assertTenant would 403 a valid grant before
		 * findItem can honour it. Collection GET and mutations stay tenant-bound. */
		const delegatedRead = method === "GET" && itemId !== null
		if (!delegatedRead) {
			assertTenant(principal, scope)
			await assertParents(entity, scope, principal)
		}
		if (entity.name === JOB.name && method === "GET") await advanceJobs()

		if (itemId === null) {
			if (method === "GET") {
				if (defects.has("RATE_LIMIT_STRICTER_THAN_DECLARED") && !throttled.has(entity.name)) {
					throttled.add(entity.name)
					return send(res, 429, { error: "rate limited" }, { "retry-after": "0" })
				}
				const key = snapshotKey(entity, scope)
				/* Only the default listing is served stale. Freezing filtered queries too would
				 * also swallow filter validation, so the defect would masquerade as several
				 * unrelated ones. */
				const plainListing = [...url.searchParams.keys()].every(
					(k) => k === dialect.params.limit || k === dialect.params.page || k === dialect.params.offset,
				)
				if (defects.has("STALE_LIST") && plainListing && staleSnapshot.has(key)) {
					const frozen = staleSnapshot.get(key) ?? []
					const items = frozen.slice(0, entity.defaultLimit)
					const stale = paginated(dialect, entity, url, {
						count: frozen.length,
						hasMore: false,
						items,
						limit: entity.defaultLimit,
						nextCursor: null,
						offset: 0,
						page: 1,
					})
					return send(res, 200, stale.body, stale.headers)
				}
				const rawFilter =
					dialect.grammar === "equality" ? equalityFilter(url, entity) : url.searchParams.get(dialect.params.filter)
				let filter: string | undefined
				if (rawFilter !== null && rawFilter !== "") {
					const canonical = toCanonicalFilter(rawFilter, dialect)
					if (canonical === null) throw new SqlError("invalid_filter", `malformed filter: ${rawFilter}`)
					filter = canonical
				}
				const param = (name: string | undefined): string | undefined =>
					name === undefined ? undefined : (url.searchParams.get(name) ?? undefined)
				const request: ListingRequest = {
					cursor: param(dialect.params.cursor),
					filter,
					limit: param(dialect.params.limit),
					offset: param(dialect.params.offset),
					order: toCanonicalOrder(param(dialect.params.order), dialect),
					page: param(dialect.params.page),
					q: param(dialect.params.search),
					searchMode: param(dialect.params.searchMode),
					select: readSelect(url, dialect, entity),
				}
				const result = await runListing(
					store,
					entity,
					request,
					{
						conventions,
						clampLimit: shape.clampLimit,
						/* A row embeds the table it belongs to: `select=id,table(name)`. */
						embed: async (relation, row) => {
							const declared = entity.relations?.[relation]
							const target = entities.find((candidate) => candidate.name === declared?.entity)
							const link = declared === undefined ? undefined : row[declared.via]
							if (target === undefined || (typeof link !== "string" && typeof link !== "number")) return null
							const related = await store.byId(target, link)
							return related === null ? null : present(target, related)
						},
						scope: { ...scope, project_id: principal.projectId },
						/* Applied to the collection only — the item route never passes through here —
						 * so a skewed field makes the two projections disagree exactly as a stale
						 * denormalised listing does. */
						transform: skewForList,
					},
					defects,
				)
				/* An unknown parameter read as a filter nothing matches. */
				const known = new Set<string>([
					...Object.values(dialect.params).filter((value): value is string => typeof value === "string"),
					dialect.selectGrammar === "bracketed" ? `${dialect.params.select}[${entity.name}]` : "",
					...(dialect.grammar === "equality" ? fieldsWhere(entity, "filterable") : []),
				])
				const unknownGiven = [...url.searchParams.keys()].some((key) => !known.has(key))
				const served =
					defects.has("UNKNOWN_PARAM_EMPTIES_LIST") && unknownGiven
						? { ...result, count: 0, hasMore: false, items: [], nextCursor: null }
						: result
				const listing = paginated(dialect, entity, url, served)
				return send(res, 200, listing.body, listing.headers)
			}

			if (method === "POST") {
				assertWrite(principal, "create")
				const form = shape.formCreate === true
				if (form) requireForm(req, defects)
				else requireJson(req, defects)
				/* Scoped by principal as well as key: two tenants using the same key must not be
				 * able to read each other's result back. */
				const idempotencyKey = req.headers["idempotency-key"]
				const replayKey =
					typeof idempotencyKey === "string" && idempotencyKey !== ""
						? `${principal.projectId}:${entity.name}:${idempotencyKey}`
						: null
				if (replayKey !== null && !defects.has("IDEMPOTENCY_IGNORED")) {
					const previous = idempotent.get(replayKey)
					if (previous !== undefined) {
						if (defects.has("IDEMPOTENT_REPLAY_INSERTS")) {
							const copy: Row = { ...previous }
							delete copy[entity.identity]
							for (const column of (entity.unique ?? []).flat()) {
								if (typeof copy[column] === "string") copy[column] = `${copy[column] as string}-replay`
							}
							await store.insert(entity, withDefaults(entity, copy, { ...scope, project_id: principal.projectId }))
						}
						return send(res, defects.has("CREATED_201_AS_200") ? 200 : 201, present(entity, previous))
					}
				}
				const received = form ? formFields(entity, await readText(req)) : await readJson(req)
				/* The crash happens on the bytes as received, before anything sanitizes them. */
				if (
					defects.has("CREATE_500_ON_NON_ASCII") &&
					Object.values(received as Row).some(
						(value) => typeof value === "string" && [...value].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f),
					)
				) {
					throw new Error("encoding error: could not write row")
				}
				const input = validateBody(entity, received, "create", defects)
				if (defects.has("STALE_LIST")) {
					const key = snapshotKey(entity, scope)
					if (!staleSnapshot.has(key)) {
						staleSnapshot.set(key, await liveRows(entity, { ...scope, project_id: principal.projectId }))
					}
				}
				if (defects.has("CREATE_DROPS_FIELD")) delete input.description

				const record = withDefaults(entity, input, { ...scope, project_id: principal.projectId })
				await assertUnique(entity, record, undefined)
				const created = await store.insert(entity, record)
				await refreshParentCount(entity, scope)
				if (replayKey !== null) idempotent.set(replayKey, created)
				return send(res, defects.has("CREATED_201_AS_200") ? 200 : 201, present(entity, created))
			}
			throw new HttpError(404, "not_found", `method ${method} not supported here`)
		}

		if (method === "GET") {
			/* Invert only the middle rank: viewer still reads, owner still reads, member does not.
			 * Denying the owner would collapse the rest of the suite. */
			if (defects.has("ROLE_MONOTONICITY_BROKEN") && principal.rank === 1) {
				throw new HttpError(403, "forbidden", "role cannot read this record")
			}
			const record = await findItem(entity, principal, itemId, scope)
			return send(res, 200, present(entity, record))
		}

		if (method === updateMethod) {
			assertWrite(principal, "update")
			requireJson(req, defects)
			const existing = await findItem(entity, principal, itemId, scope, "write")
			const replace = method === "PUT"
			const patch = validateBody(entity, await readJson(req), replace ? "replace" : "update", defects)
			/*
			 * Write only the fields the caller named.
			 *
			 * Merging the existing record and writing every column back is the `save(entity)`
			 * pattern, and it loses concurrent writes to *other* fields: whichever request
			 * commits second reinstates the values it read before the first had committed. The
			 * merged record is still built, but only to shape the response.
			 */
			/* PUT is a replacement by contract: what the body leaves out is reset, not kept. */
			const changes: Row = defects.has("PATCH_REPLACES")
				? {
						...withDefaults(entity, {}, { ...scope, project_id: principal.projectId }),
						...patch,
					}
				: replace
					? { ...replacementDefaults(entity), ...patch }
					: { ...patch }
			changes.updated_at = now()
			delete changes[entity.identity]
			delete changes.created_at
			if (!defects.has("IMMUTABLE_WRITABLE")) {
				for (const parent of entity.parents) delete changes[parent]
			}
			await assertUnique(entity, { ...existing, ...changes }, String(itemId))
			const updated = defects.has("CONCURRENT_WRITE_LOST")
				? await readModifyWrite(entity, itemId, changes)
				: await store.update(entity, itemId, changes)
			return send(
				res,
				defects.has("RESPONSE_STATUS_UNDECLARED") ? 201 : 200,
				present(entity, updated ?? { ...existing, ...changes }),
			)
		}

		if (method === "DELETE") {
			assertWrite(principal, "delete")
			const existing = await store.byId(entity, itemId)
			if (existing === null) {
				if (defects.has("DELETE_MISSING_OK")) return send(res, 200, { [entity.identity]: itemId })
				throw new HttpError(404, "not_found", `${entity.name} ${itemId} does not exist`)
			}
			const record = await findItem(entity, principal, itemId, scope, "write")
			if (entity.softDeleteField !== undefined) {
				const updated = await store.update(entity, itemId, {
					[entity.softDeleteField]: now(),
					updated_at: now(),
				})
				return send(res, 200, present(entity, updated ?? record))
			}
			await store.remove(entity, itemId)
			await refreshParentCount(entity, scope)
			return send(res, 200, present(entity, record))
		}

		throw new HttpError(405, "method_not_allowed", `method ${method} not supported`)
	}

	const server = createServer((req, res) => {
		dispatch(req, res).catch((error: unknown) => {
			if (error instanceof HttpError) {
				if (defects.has("ERROR_SCHEMA_DRIFT")) {
					return send(res, error.status, { detail: error.message, error: error.errorKey })
				}
				return send(res, error.status, {
					error_key: error.errorKey,
					message: error.message,
					status: error.status,
					success: false,
				})
			}
			if (error instanceof SqlError) {
				/* Correct behaviour is a 400. The defect lets the filter parser's own exception
				 * escape, which the transport surfaces as a 500 — validation confused with crashing. */
				if (defects.has("ERROR_500_ON_BAD_FILTER") && error.code === "invalid_filter") {
					return send(res, 500, {
						error_key: "internal_error",
						message: error.message,
						status: 500,
						success: false,
					})
				}
				return send(res, 400, {
					error_key: "invalid_input",
					message: error.message,
					status: 400,
					success: false,
				})
			}
			send(res, 500, {
				error_key: "internal_error",
				message: error instanceof Error ? error.message : String(error),
				status: 500,
				success: false,
			})
		})
	})

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo
			resolve({
				/*
				 * `server.close()` only fires once every socket is gone, and oat's client keeps
				 * connections alive — so gating teardown on that callback meant the store was
				 * never closed and a persistent backend kept every table the run created.
				 * Connections are dropped explicitly, and the store is closed either way.
				 */
				close: async () => {
					server.closeAllConnections()
					await new Promise<void>((done) => {
						server.close(() => done())
					})
					try {
						await store.close()
					} catch {
						/* Teardown must not turn a completed run into a failed one. */
					}
				},
				defects,
				principals: PRINCIPALS,
				server,
				snapshot: async () => {
					const out: Record<string, Row[]> = {}
					for (const entity of entities) {
						out[entity.name] = await store.select(entity, {
							collation: "binary",
							order: [],
							shuffleTies: false,
							where: { kind: "const", value: true },
						})
					}
					return out
				},
				url: `http://127.0.0.1:${address.port}${basePath}`,
			})
		})
	})
}

type Json = Record<string, unknown>

function send(res: ServerResponse, status: number, body: Json, extraHeaders: Record<string, string> = {}): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"content-length": Buffer.byteLength(payload),
		"content-type": "application/json",
		...extraHeaders,
	})
	res.end(payload)
}

/**
 * Rewrites a sort expression from the dialect's grammar into the canonical `field.asc` the
 * listing parses, so the storage layer never learns which spelling arrived.
 *
 * Unparseable terms are passed through untouched rather than dropped: the parser rejects an
 * unknown sort field with a 400, which is the correct answer to a malformed sort and keeps a bad
 * expression from silently becoming no sort at all.
 */
function toCanonicalOrder(expression: string | undefined, dialect: Dialect): string | undefined {
	if (expression === undefined || expression === "") return undefined
	const grammar = dialect.sortGrammar ?? "dotted"
	if (grammar === "dotted") return expression

	return expression
		.split(",")
		.map((term) => term.trim())
		.filter(Boolean)
		.map((term) => {
			if (grammar === "prefixed") {
				return term.startsWith("-") ? `${term.slice(1)}.desc` : `${term}.asc`
			}
			const separator = grammar === "colon" ? ":" : " "
			const index = term.lastIndexOf(separator)
			if (index === -1) return `${term}.asc`
			const field = term.slice(0, index).trim()
			const direction = term
				.slice(index + 1)
				.trim()
				.toLowerCase()
			return direction === "asc" || direction === "desc" ? `${field}.${direction}` : term
		})
		.join(",")
}

/**
 * Collects one-parameter-per-field equality filters into a canonical expression.
 *
 * Only fields the document declares filterable are honoured; anything else falls through to the
 * unknown-parameter path, so a caller misspelling a field still gets told rather than silently
 * receiving the whole collection.
 */
function equalityFilter(url: URL, entity: EntityDef): string | null {
	const terms: string[] = []
	for (const field of fieldsWhere(entity, "filterable")) {
		const value = url.searchParams.get(field)
		if (value === null) continue
		terms.push(`${field}.eq.${value}`)
	}
	if (terms.length === 0) return null
	return terms.length === 1 ? (terms[0] as string) : `and(${terms.join(",")})`
}

/** Reads the sparse fieldset, whether the resource lives in the parameter name or not. */
function readSelect(url: URL, dialect: Dialect, entity: EntityDef): string | undefined {
	const name =
		dialect.selectGrammar === "bracketed" ? `${dialect.params.select}[${entity.name}]` : dialect.params.select
	return url.searchParams.get(name) ?? undefined
}

/**
 * Builds a listing response in whichever pagination model the dialect speaks.
 *
 * Two genuinely different models, not two spellings: an envelope carrying the array alongside a
 * total and a more-pages flag, or a bare array whose pagination facts travel in a `Link` header.
 * Keeping both here means the routing code above never branches on it.
 */
function paginated(
	dialect: Dialect,
	entity: EntityDef,
	requestUrl: URL,
	result: {
		items: Row[]
		count: number
		hasMore: boolean
		nextCursor: string | null
		page: number | null
		offset: number
		limit: number
	},
): { body: Json; headers: Record<string, string> } {
	const env = dialect.envelope
	if (env !== null) {
		const envelope: Record<string, unknown> = { [env.collection ?? entity.plural]: result.items }
		/* Only the facts this API publishes. */
		if (env.hasMore !== undefined) envelope[env.hasMore] = result.hasMore
		if (env.limit !== undefined) envelope[env.limit] = result.limit
		if (env.page !== undefined) envelope[env.page] = result.page
		if (env.total !== undefined) envelope[env.total] = result.count
		if (env.nextCursor !== undefined) envelope[env.nextCursor] = result.nextCursor
		return { body: envelope as Json, headers: {} }
	}

	/* Root array: the only pagination signal is the header, so a caller learns there is more by
	 * being handed the URL that returns it — never by a field. */
	const links: string[] = []
	const offsetParam = dialect.params.offset
	if (result.hasMore && offsetParam !== undefined) {
		const next = new URL(requestUrl.toString())
		next.searchParams.set(offsetParam, String(result.offset + result.items.length))
		links.push(`<${next.pathname}${next.search}>; rel="next"`)
	}
	return {
		body: result.items as unknown as Json,
		headers: links.length > 0 ? { link: links.join(", ") } : {},
	}
}

function requireForm(req: IncomingMessage, defects: DefectSet): void {
	if (defects.has("CONTENT_TYPE_NOT_ENFORCED")) return
	const type = req.headers["content-type"]
	if (typeof type !== "string" || !type.includes("application/x-www-form-urlencoded")) {
		throw new HttpError(415, "unsupported_media_type", "expected application/x-www-form-urlencoded")
	}
}

async function readText(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	return Buffer.concat(chunks).toString("utf8")
}

function requireJson(req: IncomingMessage, defects: DefectSet): void {
	if (defects.has("CONTENT_TYPE_NOT_ENFORCED")) return
	const type = req.headers["content-type"]
	if (typeof type !== "string" || !type.includes("application/json")) {
		throw new HttpError(415, "unsupported_media_type", "expected application/json")
	}
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = []
	for await (const chunk of req) chunks.push(chunk as Buffer)
	const text = Buffer.concat(chunks).toString("utf8")
	if (text.trim() === "") return {}
	try {
		return JSON.parse(text)
	} catch {
		throw new HttpError(400, "invalid_input", "request body is not valid JSON")
	}
}

/** In-memory reference server — no dependencies, no flags, nothing to have running. */
export async function createMemoryServer(options: ReferenceOptions = {}): Promise<ReferenceServer> {
	const { MemoryStore } = await import("./stores/memory.ts")
	return createReferenceServer(options, async () => new MemoryStore())
}

/** SQLite-backed reference server, in-process via `node:sqlite`. */
export async function createSqliteServer(options: ReferenceOptions = {}): Promise<ReferenceServer> {
	const { SqlStore } = await import("./stores/sqlite.ts")
	const { nodeSqliteDriver } = await import("./stores/sqlite-driver.ts")
	return createReferenceServer(options, async (defects, entities) =>
		SqlStore.create(defects, await nodeSqliteDriver(), "", entities),
	)
}

/**
 * Cloudflare D1 reference server — the same SQL over the network, against someone else's build.
 *
 * Credentials come from the environment rather than config so a token never reaches a file that
 * could be committed. Tables are prefixed per run and dropped on close, because D1 persists: two
 * runs sharing one database would otherwise contaminate each other's results.
 */
export async function createD1Server(
	options: ReferenceOptions & {
		accountId?: string
		databaseId?: string
		apiToken?: string
	} = {},
): Promise<ReferenceServer> {
	const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID
	const databaseId = options.databaseId ?? process.env.CLOUDFLARE_D1_DATABASE_ID
	const apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN
	const missing = [
		accountId === undefined ? "CLOUDFLARE_ACCOUNT_ID" : null,
		databaseId === undefined ? "CLOUDFLARE_D1_DATABASE_ID" : null,
		apiToken === undefined ? "CLOUDFLARE_API_TOKEN" : null,
	].filter((name): name is string => name !== null)
	if (missing.length > 0) {
		throw new Error(`D1 backend needs ${missing.join(", ")} in the environment`)
	}

	const { SqlStore } = await import("./stores/sqlite.ts")
	const { d1Driver } = await import("./stores/sqlite-driver.ts")
	const prefix = `oat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_`
	return createReferenceServer(options, (defects, entities) =>
		SqlStore.create(
			defects,
			d1Driver({
				accountId: accountId as string,
				apiToken: apiToken as string,
				databaseId: databaseId as string,
			}),
			prefix,
			entities,
		),
	)
}

/** Postgres-backed reference server. Imported lazily so the driver is only loaded when used. */
export async function createPostgresServer(options: ReferenceOptions = {}): Promise<ReferenceServer> {
	const { PgStore } = await import("./stores/postgres.ts")
	return createReferenceServer(options, (defects, entities) => PgStore.create(defects, entities))
}
