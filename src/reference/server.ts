/**
 * In-memory reference backend. No database, no dependencies, starts in milliseconds.
 *
 * Correct by default; every deviation is an explicit, named defect. oat must report nothing at
 * all against the clean baseline — that is the false-positive bar, and it is the harder one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { type DefectSet, DefectSet as Defects } from "./defects.ts"
import { ENTITIES, type EntityDef, type FieldDef, fieldsWhere, writableFields } from "./model.ts"
import { QueryError, type Row, runQuery } from "./query.ts"
import { buildSpec, buildUntaggedSpec } from "./spec.ts"

interface Principal {
	key: string
	token: string
	projectId: string
}

const PRINCIPALS: Principal[] = [
	{ key: "key_alpha", projectId: "proj_alpha", token: "tok_alpha" },
	{ key: "key_beta", projectId: "proj_beta", token: "tok_beta" },
]

class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly errorKey: string,
		message: string,
	) {
		super(message)
	}
}

interface Store {
	tables: Map<string, Row>
	rows: Map<string, Row>
	staleSnapshot: Map<string, Row[]>
}

let sequence = 0
function nextId(prefix: string): string {
	sequence += 1
	return `${prefix}_${String(sequence).padStart(6, "0")}`
}

function now(): number {
	/* Monotonic and deterministic: wall-clock timestamps make ordering assertions flaky. */
	return 1_700_000_000_000 + sequence * 1000
}

function collectionOf(store: Store, entity: EntityDef): Map<string, Row> {
	return entity.name === "table" ? store.tables : store.rows
}

/* ------------------------------------------------------------------ validation */

function validateBody(
	entity: EntityDef,
	body: unknown,
	phase: "create" | "update",
	defects: DefectSet,
): Row {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "invalid_input", "request body must be a JSON object")
	}
	const input = body as Row
	const allowed = new Map(writableFields(entity, phase).map((f) => [f.name, f]))

	for (const key of Object.keys(input)) {
		if (allowed.has(key)) continue
		const known = entity.fields.find((f) => f.name === key)
		if (known !== undefined && (known.immutable === true || known.generated === true)) {
			/* Correct behaviour is to reject a write to a server-owned field. The defect accepts
			 * it and lets the value through, which is what makes the field actually mutable. */
			if (defects.has("IMMUTABLE_WRITABLE")) {
				allowed.set(key, known)
				continue
			}
			throw new HttpError(400, "invalid_input", `field "${key}" is not writable`)
		}
		throw new HttpError(400, "invalid_input", `unknown field "${key}"`)
	}

	if (phase === "create") {
		for (const field of allowed.values()) {
			if (
				field.required === true
				&& input[field.name] === undefined
				&& !defects.has("REQUIRED_NOT_VALIDATED")
			) {
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
	const actual = typeof value
	if (field.type === "integer" || field.type === "number") {
		if (actual !== "number") {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be a number`)
		}
		if (field.type === "integer" && !Number.isInteger(value)) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be an integer`)
		}
		return value
	}
	if (field.type === "boolean") {
		if (actual !== "boolean") {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be a boolean`)
		}
		return value
	}
	if (actual !== "string") {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be a string`)
	}
	const text = value as string
	if (
		field.maxLength !== undefined
		&& text.length > field.maxLength
		&& !defects.has("MAXLENGTH_NOT_VALIDATED")
	) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" exceeds maxLength ${field.maxLength}`)
	}
	if (field.enum !== undefined && !field.enum.includes(text) && !defects.has("ENUM_NOT_VALIDATED")) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be one of ${field.enum.join(", ")}`)
	}
	return text
}

function withDefaults(entity: EntityDef, input: Row, scope: Record<string, string>): Row {
	const record: Row = { ...input }
	record[entity.identity] = nextId(entity.name)
	for (const parent of entity.parents) {
		const key = parent === "project_id" ? "project_id" : parent
		if (entity.fields.some((f) => f.name === key)) record[key] = scope[parent] ?? null
	}
	record.created_at = now()
	record.updated_at = now()
	if (entity.softDeleteField !== undefined) record[entity.softDeleteField] = null
	for (const field of entity.fields) {
		if (record[field.name] !== undefined) continue
		record[field.name] = field.nullable === true ? null : defaultFor(field)
	}
	return record
}

/** RESPONSE_SCHEMA_DRIFT adds a field the document never declares. */
function decorate(record: Row, defects: DefectSet): Row {
	if (!defects.has("RESPONSE_SCHEMA_DRIFT")) return record
	return { ...record, _internal_revision: 7, _shard: "shard-a" }
}

function defaultFor(field: FieldDef): unknown {
	switch (field.type) {
		case "boolean":
			return false
		case "integer":
		case "number":
			return 0
		default:
			return field.enum?.[0] ?? ""
	}
}

/* --------------------------------------------------------------------- routing */

interface Match {
	entity: EntityDef
	scope: Record<string, string>
	itemId: string | null
}

function matchRoute(pathname: string): Match | null {
	const segments = pathname.split("/").filter(Boolean)
	for (const entity of ENTITIES) {
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
				if (part.startsWith("{")) scope[part.slice(1, -1)] = value
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

/* ------------------------------------------------------------------- handlers */

export interface ReferenceServer {
	server: Server
	url: string
	defects: DefectSet
	reset: () => void
	close: () => Promise<void>
	principals: Principal[]
}

export function createReferenceServer(options: { defects?: string[]; untagged?: boolean } = {}): Promise<ReferenceServer> {
	const defects = new Defects(options.defects ?? [])
	const store: Store = { rows: new Map(), staleSnapshot: new Map(), tables: new Map() }

	function reset(): void {
		store.tables.clear()
		store.rows.clear()
		store.staleSnapshot.clear()
		sequence = 0
	}

	function authenticate(req: IncomingMessage): Principal {
		const header = req.headers.authorization
		if (typeof header !== "string" || !header.startsWith("Bearer ")) {
			throw new HttpError(401, "unauthorized", "missing bearer credential")
		}
		const token = header.slice(7).trim()
		const principal = PRINCIPALS.find((p) => p.token === token)
		if (principal === undefined) throw new HttpError(401, "unauthorized", "unrecognised credential")
		return principal
	}

	function assertTenant(principal: Principal, scope: Record<string, string>): void {
		const projectId = scope.project_id
		if (projectId !== undefined && projectId !== principal.projectId) {
			throw new HttpError(403, "forbidden", "resource belongs to another tenant")
		}
	}

	function visible(entity: EntityDef, principal: Principal, scope: Record<string, string>): Row[] {
		const all = [...collectionOf(store, entity).values()]
		return all.filter((record) => {
			if (entity.name === "table") return record.project_id === principal.projectId
			const parent = store.tables.get(String(record.table_id))
			if (parent === undefined) return false
			if (parent.project_id !== principal.projectId) return false
			return scope.table_id === undefined || record.table_id === scope.table_id
		})
	}

	function snapshotKey(entity: EntityDef, scope: Record<string, string>): string {
		return `${entity.name}:${scope.project_id ?? ""}:${scope.table_id ?? ""}`
	}

	function captureStale(entity: EntityDef, principal: Principal, scope: Record<string, string>): void {
		if (!defects.has("STALE_LIST")) return
		const key = snapshotKey(entity, scope)
		if (!store.staleSnapshot.has(key)) {
			store.staleSnapshot.set(key, visible(entity, principal, scope).map((r) => ({ ...r })))
		}
	}

	function handleList(entity: EntityDef, principal: Principal, scope: Record<string, string>, url: URL): Json {
		const key = snapshotKey(entity, scope)
		const source = defects.has("STALE_LIST") && store.staleSnapshot.has(key)
			? (store.staleSnapshot.get(key) ?? [])
			: visible(entity, principal, scope)

		/* Under TENANT_LEAK_VIA_FILTER the tenant predicate is applied to the base listing but
		 * not re-checked against filter matches — so an explicit id filter reaches across. */
		const pool = defects.has("TENANT_LEAK_VIA_FILTER") && url.searchParams.has("filter")
			? [...collectionOf(store, entity).values()]
			: source

		const number = (name: string): number | undefined => {
			const raw = url.searchParams.get(name)
			if (raw === null) return undefined
			const parsed = Number(raw)
			if (!Number.isFinite(parsed)) {
				throw new HttpError(400, "invalid_input", `query parameter "${name}" must be numeric`)
			}
			return parsed
		}

		const result = runQuery(
			pool,
			{
				cursor: url.searchParams.get("cursor") ?? undefined,
				filter: url.searchParams.get("filter") ?? undefined,
				limit: number("limit"),
				order: url.searchParams.get("order") ?? undefined,
				page: number("page"),
				q: url.searchParams.get("q") ?? undefined,
				select: url.searchParams.get("select") ?? undefined,
			},
			{
				defaultLimit: entity.defaultLimit,
				filterable: fieldsWhere(entity, "filterable"),
				identity: entity.identity,
				maxLimit: entity.maxLimit,
				searchable: fieldsWhere(entity, "searchable"),
				sortable: fieldsWhere(entity, "sortable"),
				...(entity.softDeleteField === undefined ? {} : { softDeleteField: entity.softDeleteField }),
			},
			defects,
		)

		return {
			count: result.count,
			hasMore: result.hasMore,
			limit: result.limit,
			nextCursor: result.nextCursor,
			page: result.page,
			[entity.plural]: result.items,
		}
	}

	function findItem(entity: EntityDef, principal: Principal, scope: Record<string, string>, id: string): Row {
		const record = collectionOf(store, entity).get(id)
		if (record === undefined) throw new HttpError(404, "not_found", `${entity.name} ${id} does not exist`)
		if (!defects.has("CROSS_TENANT_READ")) {
			const owned = visible(entity, principal, scope).some((r) => r[entity.identity] === id)
			if (!owned) throw new HttpError(404, "not_found", `${entity.name} ${id} does not exist`)
		}
		if (entity.softDeleteField !== undefined && record[entity.softDeleteField] !== null) {
			throw new HttpError(404, "not_found", `${entity.name} ${id} has been deleted`)
		}
		return record
	}

	async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost")
		const method = (req.method ?? "GET").toUpperCase()

		if (url.pathname === "/v1/openapi/spec") {
			return send(res, 200, options.untagged === true ? buildUntaggedSpec() : buildSpec())
		}

		if (url.pathname === "/v1/auth/token" && method === "POST") {
			const body = await readJson(req)
			const key = (body as { key?: unknown }).key
			const principal = PRINCIPALS.find((p) => p.key === key)
			if (principal === undefined) throw new HttpError(401, "unauthorized", "unknown API key")
			return send(res, 200, {
				access_token: principal.token,
				expires_in: 3600,
				project_id: principal.projectId,
			})
		}

		const match = matchRoute(url.pathname)
		if (match === null) throw new HttpError(404, "not_found", `no route for ${url.pathname}`)

		const principal = authenticate(req)
		assertTenant(principal, match.scope)
		const { entity, scope, itemId } = match

		if (itemId === null) {
			if (method === "GET") return send(res, 200, handleList(entity, principal, scope, url))
			if (method === "POST") {
				requireJsonContentType(req, defects)
				const input = validateBody(entity, await readJson(req), "create", defects)
				captureStale(entity, principal, scope)
				/* CREATE_DROPS_FIELD accepts the field, echoes nothing back for it, and stores the
				 * default — the write appears to succeed and the value is simply gone. */
				if (defects.has("CREATE_DROPS_FIELD")) delete input.description
				const record = withDefaults(entity, input, scope)
				if (entity.name === "row") record.table_id = scope.table_id ?? null
				collectionOf(store, entity).set(String(record[entity.identity]), record)
				return send(
					res,
					defects.has("CREATED_201_AS_200") ? 200 : 201,
					decorate(record, defects),
				)
			}
			throw new HttpError(404, "not_found", `method ${method} not supported here`)
		}

		if (method === "GET") return send(res, 200, findItem(entity, principal, scope, itemId))

		if (method === "PATCH") {
			requireJsonContentType(req, defects)
			const existing = findItem(entity, principal, scope, itemId)
			const patch = validateBody(entity, await readJson(req), "update", defects)
			captureStale(entity, principal, scope)
			/* PATCH_REPLACES rebuilds the record from defaults, discarding anything the caller
			 * did not resend — the classic accidental-PUT. */
			const base = defects.has("PATCH_REPLACES")
				? withDefaults(entity, {}, scope)
				: { ...existing }
			const updated: Row = { ...base, ...patch }
			updated.created_at = existing.created_at
			updated.updated_at = now()
			if (!defects.has("IMMUTABLE_WRITABLE")) {
				updated[entity.identity] = existing[entity.identity]
				if (entity.name === "row") updated.table_id = existing.table_id
				if (entity.name === "table") updated.project_id = existing.project_id
			} else {
				/* Identity still has to key the map, but every other immutable field is now
				 * whatever the caller said. */
				updated[entity.identity] = existing[entity.identity]
			}
			collectionOf(store, entity).set(itemId, updated)
			return send(res, 200, updated)
		}

		if (method === "DELETE") {
			const collection = collectionOf(store, entity)
			const existing = collection.get(itemId)
			if (existing === undefined) {
				if (defects.has("DELETE_MISSING_OK")) return send(res, 200, { [entity.identity]: itemId })
				throw new HttpError(404, "not_found", `${entity.name} ${itemId} does not exist`)
			}
			const record = findItem(entity, principal, scope, itemId)
			captureStale(entity, principal, scope)
			if (entity.softDeleteField !== undefined) {
				record[entity.softDeleteField] = now()
				record.updated_at = now()
				collection.set(itemId, record)
			} else {
				collection.delete(itemId)
			}
			return send(res, 200, record)
		}

		throw new HttpError(404, "not_found", `method ${method} not supported`)
	}

	const server = createServer((req, res) => {
		dispatch(req, res).catch((error: unknown) => {
			if (error instanceof HttpError) {
				/* ERROR_SCHEMA_DRIFT renames the discriminator and drops a required member, so the
				 * envelope no longer validates against the documented error schema. */
				if (defects.has("ERROR_SCHEMA_DRIFT")) {
					return send(res, error.status, { error: error.errorKey, detail: error.message })
				}
				return send(res, error.status, {
					error_key: error.errorKey,
					message: error.message,
					status: error.status,
					success: false,
				})
			}
			if (error instanceof QueryError) {
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
				close: () => new Promise((done) => server.close(() => done())),
				defects,
				principals: PRINCIPALS,
				reset,
				server,
				url: `http://127.0.0.1:${address.port}`,
			})
		})
	})
}

type Json = Record<string, unknown>

function send(res: ServerResponse, status: number, body: Json): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"content-length": Buffer.byteLength(payload),
		"content-type": "application/json",
	})
	res.end(payload)
}

function requireJsonContentType(req: IncomingMessage, defects: DefectSet): void {
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
