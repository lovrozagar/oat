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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { DefectSet as Defects, type DefectSet } from "./defects.ts"
import { ENTITIES, type EntityDef, type FieldDef, JOB, fieldsWhere, writableFields } from "./model.ts"
import { type Dialect, DIALECTS, POSTGREST, toCanonicalFilter } from "./dialect.ts"
import { buildSpec, buildUntaggedSpec } from "./spec.ts"
import { SqlError, type Row, type Store } from "./store-api.ts"

interface Principal {
	key: string
	token: string
	projectId: string
}

const PRINCIPALS: Principal[] = [
	{ key: "key_alpha", projectId: "proj_alpha", token: "tok_alpha" },
	{ key: "key_beta", projectId: "proj_beta", token: "tok_beta" },
]

const TENANT_FIELD = "project_id"

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
				field.required === true &&
				input[field.name] === undefined &&
				!defects.has("REQUIRED_NOT_VALIDATED")
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
	if (field.type === "integer" || field.type === "number") {
		if (typeof value !== "number") {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be a number`)
		}
		if (field.type === "integer" && !Number.isInteger(value)) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be an integer`)
		}
		return value
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
	if (
		field.maxLength !== undefined &&
		value.length > field.maxLength &&
		!defects.has("MAXLENGTH_NOT_VALIDATED")
	) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" exceeds maxLength`)
	}
	if (field.enum !== undefined && !field.enum.includes(value) && !defects.has("ENUM_NOT_VALIDATED")) {
		throw new HttpError(400, "invalid_input", `field "${field.name}" must be one of ${field.enum.join(", ")}`)
	}
	return value
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

/* ------------------------------------------------------------------- the server */

export interface ReferenceServer {
	server: Server
	url: string
	defects: DefectSet
	close: () => Promise<void>
	principals: Principal[]
}

/**
 * One server, any store. Defining a defect once and exercising it on every engine is what makes
 * a disagreement between engines meaningful rather than an artefact of two implementations.
 */
export async function createReferenceServer(
	options: { defects?: string[]; untagged?: boolean; dialect?: string },
	/* Required, and every caller supplies it by dynamic import: a static import of a storage
	 * module would load that engine's driver for *every* backend, and a missing optional
	 * runtime (node:sqlite behind a flag) would then take down paths that never touch it. */
	createStore: (defects: DefectSet) => Promise<Store>,
): Promise<ReferenceServer> {
	const defects = new Defects(options.defects ?? [])
	const dialect: Dialect = DIALECTS[options.dialect ?? "postgrest"] ?? POSTGREST
	const store = await createStore(defects)
	const jobStartedAt = new Map<string, number>()
	/* Snapshot of a collection taken before a write, replayed while STALE_LIST is on. */
	const staleSnapshot = new Map<string, Row[]>()
	/* Idempotency-Key → the record the first request created, so a replay returns it. */
	const idempotent = new Map<string, Row>()

	function authenticate(req: IncomingMessage): Principal {
		const header = req.headers.authorization
		if (typeof header !== "string" || !header.startsWith("Bearer ")) {
			throw new HttpError(401, "unauthorized", "missing bearer credential")
		}
		const principal = PRINCIPALS.find((p) => p.token === header.slice(7).trim())
		if (principal === undefined) throw new HttpError(401, "unauthorized", "unrecognised credential")
		return principal
	}

	function assertTenant(principal: Principal, scope: Record<string, string>): void {
		const projectId = scope.project_id
		if (projectId !== undefined && projectId !== principal.projectId) {
			throw new HttpError(403, "forbidden", "resource belongs to another tenant")
		}
	}

	/** Walks a record up its parent chain to the owning tenant, driven by the descriptors. */
	async function ownedByTenant(
		entity: EntityDef,
		record: Row,
		principal: Principal,
	): Promise<boolean> {
		if (entity.fields.some((f) => f.name === TENANT_FIELD)) {
			return record[TENANT_FIELD] === principal.projectId
		}
		for (const parentParam of entity.parents) {
			const parentEntity = ENTITIES.find((e) => e.itemParam === parentParam)
			if (parentEntity === undefined) continue
			const link = record[parentParam]
			if (typeof link !== "string") continue
			const parent = await store.byId(parentEntity, link)
			if (parent === null) return false
			return ownedByTenant(parentEntity, parent, principal)
		}
		return false
	}

	function projectJob(job: Row): Row {
		const startedAt = jobStartedAt.get(String(job.id))
		if (startedAt === undefined || defects.has("ASYNC_NEVER_COMPLETES")) return job
		const ratio = Math.min((Date.now() - startedAt) / 60, 1)
		const progress = Math.floor(ratio * 100)
		return { ...job, progress, status: ratio >= 1 ? "complete" : progress > 0 ? "running" : "pending" }
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

	function withDefaults(entity: EntityDef, input: Row, scope: Record<string, string>): Row {
		const record: Row = { ...input }
		record[entity.identity] = store.nextId(entity.name)
		for (const parent of entity.parents) {
			if (entity.fields.some((f) => f.name === parent)) record[parent] = scope[parent] ?? null
		}
		record.created_at = store.now()
		record.updated_at = store.now()
		if (entity.softDeleteField !== undefined) record[entity.softDeleteField] = null
		for (const field of entity.fields) {
			if (record[field.name] !== undefined) continue
			record[field.name] =
				field.nullable === true
					? null
					: field.type === "boolean"
						? false
						: field.type === "integer" || field.type === "number"
							? 0
							: (field.enum?.[0] ?? "")
		}
		return record
	}

	function snapshotKey(entity: EntityDef, scope: Record<string, string>): string {
		return `${entity.name}:${scope.project_id ?? ""}:${scope.table_id ?? ""}`
	}

	/**
	 * Keeps a parent's derived count current after a child write.
	 *
	 * This is the behaviour `x-invalidate` promises: a write here changes what a *different*
	 * route serves. Under the defect the promise is published and not kept, which is the common
	 * real failure — a denormalised counter or a cached projection that nobody refreshes.
	 */
	async function refreshParentCount(
		entity: EntityDef,
		scope: Record<string, string>,
		principal: Principal,
	): Promise<void> {
		if (entity.name !== "row") return
		if (defects.has("PARENT_PROJECTION_STALE")) return
		const table = ENTITIES.find((candidate) => candidate.name === "table")
		const tableId = scope.table_id
		if (table === undefined || tableId === undefined) return
		/*
		 * Paged, because the store caps a page at the entity's declared maxLimit — `row` allows 5 —
		 * so a single large-limit query silently counts one page rather than the collection.
		 *
		 * The envelope's own total is deliberately not used either: a defect that corrupts the
		 * reported count would propagate into this derived value and make the parent look stale
		 * for a reason that has nothing to do with invalidation.
		 */
		const pageSize = entity.maxLimit
		let total = 0
		for (let page = 1; page <= 200; page++) {
			const chunk = await store.query(
				entity,
				{ ...scope, project_id: principal.projectId },
				{ limit: pageSize, page },
				{ softDeleteField: entity.softDeleteField },
			)
			total += chunk.items.length
			if (chunk.items.length < pageSize) break
		}
		await store.update(table, tableId, { row_count: total })
	}

	async function findItem(entity: EntityDef, principal: Principal, id: string): Promise<Row> {
		const record = await store.byId(entity, id)
		if (record === null) throw new HttpError(404, "not_found", `${entity.name} ${id} does not exist`)
		if (!defects.has("CROSS_TENANT_READ") && !(await ownedByTenant(entity, record, principal))) {
			/* Correct is 404: the same answer an id that never existed would get. Answering 403
			 * here is the defect — the denial is right, but the *status* confirms the record is
			 * real, which is all an attacker enumerating identifiers needs. */
			throw defects.has("EXISTENCE_LEAK_VIA_STATUS")
				? new HttpError(403, "forbidden", `${entity.name} ${id} belongs to another tenant`)
				: new HttpError(404, "not_found", `${entity.name} ${id} does not exist`)
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
			return send(
				res,
				200,
				options.untagged === true ? buildUntaggedSpec(dialect) : buildSpec(dialect),
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
			const name = (await readJson(req) as { name?: unknown }).name
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

		const match = matchRoute(url.pathname)
		if (match === null) throw new HttpError(404, "not_found", `no route for ${url.pathname}`)

		const principal = authenticate(req)
		assertTenant(principal, match.scope)
		const { entity, scope, itemId } = match

		if (itemId === null) {
			if (method === "GET") {
				const key = snapshotKey(entity, scope)
				/* Only the default listing is served stale. Freezing filtered queries too would
				 * also swallow filter validation, so the defect would masquerade as several
				 * unrelated ones. */
				const plainListing = [...url.searchParams.keys()].every(
					(k) =>
						k === dialect.params.limit
						|| k === dialect.params.page
						|| k === dialect.params.offset,
				)
				if (defects.has("STALE_LIST") && plainListing && staleSnapshot.has(key)) {
					const frozen = staleSnapshot.get(key) ?? []
					const stale = paginated(dialect, entity, url, {
						count: frozen.length,
						hasMore: false,
						items: frozen,
						limit: entity.defaultLimit,
						nextCursor: null,
						page: 1,
					})
					return send(res, 200, stale.body, stale.headers)
				}
				const number = (name: string): number | undefined => {
					const raw = url.searchParams.get(name)
					if (raw === null) return undefined
					const parsed = Number(raw)
					if (!Number.isFinite(parsed)) {
						throw new HttpError(400, "invalid_input", `query parameter "${name}" must be numeric`)
					}
					return parsed
				}
				const rawFilter =
					dialect.grammar === "equality"
						? equalityFilter(url, entity)
						: url.searchParams.get(dialect.params.filter)
				let filter: string | undefined
				/* Only when a sort is also present: alone, the filter behaves perfectly. */
				const sorted = url.searchParams.get(dialect.params.order)
				const dropFilter =
					defects.has("FILTER_DROPPED_WHEN_SORTED") && sorted !== null && sorted !== ""
				if (rawFilter !== null && rawFilter !== "" && !dropFilter) {
					const canonical = toCanonicalFilter(rawFilter, dialect)
					if (canonical === null) {
						/* A filter the dialect cannot parse is bad client input, so 400 — unless the
						 * defect that turns parse failures into server errors is active. Routing this
						 * path through the same defect matters: on a dialect whose grammar rejects a
						 * malformed value here rather than in the store, the store's 500 path is never
						 * reached and the defect would be silently inexpressible. */
						throw defects.has("ERROR_500_ON_BAD_FILTER")
							? new HttpError(500, "internal_error", "filter parser threw")
							: new HttpError(400, "invalid_input", `malformed filter: ${rawFilter}`)
					}
					filter = canonical
				}

				/*
				 * Under the defect the predicate is withheld from the store, so the page window is
				 * computed over the unfiltered set; the filter is then applied to whatever that
				 * window contained. Modelled here rather than in each store because it is a bug in
				 * *ordering of operations*, not in any one engine's query compiler.
				 */
				const pageBeforeFilter =
					defects.has("FILTER_AFTER_PAGINATION") && filter !== undefined
				const result = await store.query(
					entity,
					{ ...scope, project_id: principal.projectId },
					{
						cursor:
							dialect.params.cursor === undefined
								? undefined
								: (url.searchParams.get(dialect.params.cursor) ?? undefined),
						filter: pageBeforeFilter ? undefined : filter,
						limit: number(dialect.params.limit),
						order: toCanonicalOrder(
							url.searchParams.get(dialect.params.order) ?? undefined,
							dialect,
						),
						/* Whichever the dialect publishes. The store pages by number, so an offset is
						 * converted using the page size actually in force — the same arithmetic the
						 * caller performed to produce the offset. */
						page: pageFrom(url, dialect, number(dialect.params.limit) ?? entity.defaultLimit),
						q: url.searchParams.get(dialect.params.search) ?? undefined,
						select: readSelect(url, dialect, entity),
					},
					{
						softDeleteField: entity.softDeleteField,
						/* Applied to the collection only — the item route never passes through here —
						 * so a skewed field makes the two projections disagree exactly as a stale
						 * denormalised listing does. */
						transform: (row: Row) =>
							skewForList(entity.name === "job" ? projectJob(row) : row),
					},
				)
				if (pageBeforeFilter && filter !== undefined) {
					const matching = await store.query(
						entity,
						{ ...scope, project_id: principal.projectId },
						{ filter, limit: 1000 },
						{ softDeleteField: entity.softDeleteField },
					)
					const allowed = new Set(matching.items.map((row) => String(row[entity.identity])))
					result.items = result.items.filter((row) =>
						allowed.has(String(row[entity.identity])),
					)
				}
				const listing = paginated(dialect, entity, url, result)
				return send(res, 200, listing.body, listing.headers)
			}

			if (method === "POST") {
				requireJson(req, defects)
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
						return send(res, defects.has("CREATED_201_AS_200") ? 200 : 201, decorate(previous))
					}
				}
				const input = validateBody(entity, await readJson(req), "create", defects)
				if (defects.has("STALE_LIST")) {
					const key = snapshotKey(entity, scope)
					if (!staleSnapshot.has(key)) {
						staleSnapshot.set(
							key,
							(
								await store.query(
									entity,
									{ ...scope, project_id: principal.projectId },
									{ limit: 1000 },
									{ softDeleteField: entity.softDeleteField },
								)
							).items,
						)
					}
				}
				if (defects.has("CREATE_DROPS_FIELD")) delete input.description
				const record = withDefaults(entity, input, { ...scope, project_id: principal.projectId })
				const created = await store.insert(entity, record)
				if (entity.name === "job") jobStartedAt.set(String(created.id), Date.now())
				await refreshParentCount(entity, scope, principal)
				if (replayKey !== null) idempotent.set(replayKey, created)
				return send(res, defects.has("CREATED_201_AS_200") ? 200 : 201, decorate(created))
			}
			throw new HttpError(404, "not_found", `method ${method} not supported here`)
		}

		if (method === "GET") {
			const record = await findItem(entity, principal, itemId)
			return send(res, 200, decorate(entity.name === "job" ? projectJob(record) : record))
		}

		if (method === "PATCH") {
			requireJson(req, defects)
			const existing = await findItem(entity, principal, itemId)
			const patch = validateBody(entity, await readJson(req), "update", defects)
			/*
			 * Write only the fields the caller named.
			 *
			 * Merging the existing record and writing every column back is the `save(entity)`
			 * pattern, and it loses concurrent writes to *other* fields: whichever request
			 * commits second reinstates the values it read before the first had committed. The
			 * merged record is still built, but only to shape the response.
			 */
			const changes: Row = defects.has("PATCH_REPLACES")
				? {
						...withDefaults(entity, {}, { ...scope, project_id: principal.projectId }),
						...patch,
					}
				: { ...patch }
			changes.updated_at = store.now()
			delete changes[entity.identity]
			delete changes.created_at
			if (!defects.has("IMMUTABLE_WRITABLE")) {
				for (const parent of entity.parents) delete changes[parent]
			}
			const updated = await store.update(entity, itemId, changes)
			return send(res, 200, decorate(updated ?? { ...existing, ...changes }))
		}

		if (method === "DELETE") {
			const existing = await store.byId(entity, itemId)
			if (existing === null) {
				if (defects.has("DELETE_MISSING_OK")) return send(res, 200, { [entity.identity]: itemId })
				throw new HttpError(404, "not_found", `${entity.name} ${itemId} does not exist`)
			}
			const record = await findItem(entity, principal, itemId)
			if (entity.softDeleteField !== undefined) {
				const updated = await store.update(entity, itemId, {
					[entity.softDeleteField]: store.now(),
					updated_at: store.now(),
				})
				return send(res, 200, decorate(updated ?? record))
			}
			await store.remove(entity, itemId)
			return send(res, 200, decorate(record))
		}

		throw new HttpError(404, "not_found", `method ${method} not supported`)
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
				if (defects.has("ERROR_500_ON_BAD_FILTER")) {
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
				url: `http://127.0.0.1:${address.port}`,
			})
		})
	})
}

type Json = Record<string, unknown>

function send(
	res: ServerResponse,
	status: number,
	body: Json,
	extraHeaders: Record<string, string> = {},
): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		"content-length": Buffer.byteLength(payload),
		"content-type": "application/json",
		...extraHeaders,
	})
	res.end(payload)
}

/**
 * Rewrites a sort expression from the dialect's grammar into the canonical `field.asc` the stores
 * parse, so the storage layer never learns which spelling arrived.
 *
 * Unparseable terms are passed through untouched rather than dropped: the store rejects an
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
			const direction = term.slice(index + 1).trim().toLowerCase()
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
		dialect.selectGrammar === "bracketed"
			? `${dialect.params.select}[${entity.name}]`
			: dialect.params.select
	return url.searchParams.get(name) ?? undefined
}

/**
 * The page number a request is asking for, whichever way the dialect counts.
 *
 * The store pages by number; an API that counts rows skipped is converted using the page size in
 * force — the same arithmetic the caller did to produce the offset. An offset that is not a whole
 * multiple of the page size has no exact page number, and rounding down matches what every offset
 * API does anyway: return the window starting there.
 */
function pageFrom(url: URL, dialect: Dialect, pageSize: number): number | undefined {
	const read = (name: string | undefined): number | undefined => {
		if (name === undefined) return undefined
		const raw = url.searchParams.get(name)
		if (raw === null) return undefined
		const parsed = Number(raw)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	const page = read(dialect.params.page)
	if (page !== undefined) return page
	const offset = read(dialect.params.offset)
	if (offset === undefined) return undefined
	return Math.floor(offset / Math.max(pageSize, 1)) + 1
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
	result: { items: Row[]; count: number; hasMore: boolean; nextCursor: string | null; page: number | null; limit: number },
): { body: Json; headers: Record<string, string> } {
	if (dialect.envelope !== null) {
		const envelope: Record<string, unknown> = {
			[dialect.envelope.collection ?? entity.plural]: result.items,
			[dialect.envelope.hasMore]: result.hasMore,
			[dialect.envelope.limit]: result.limit,
			[dialect.envelope.page]: result.page,
			[dialect.envelope.total]: result.count,
		}
		if (dialect.envelope.nextCursor !== undefined) {
			envelope[dialect.envelope.nextCursor] = result.nextCursor
		}
		return { body: envelope as Json, headers: {} }
	}

	/* Root array: the only pagination signal is the header, so a caller learns there is more by
	 * being handed the URL that returns it — never by a field. */
	const links: string[] = []
	const offsetParam = dialect.params.offset
	if (result.hasMore && offsetParam !== undefined) {
		const next = new URL(requestUrl.toString())
		const consumed = Number(next.searchParams.get(offsetParam) ?? 0) + result.items.length
		next.searchParams.set(offsetParam, String(consumed))
		links.push(`<${next.pathname}${next.search}>; rel="next"`)
	}
	return {
		body: result.items as unknown as Json,
		headers: links.length > 0 ? { link: links.join(", ") } : {},
	}
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
export async function createMemoryServer(
	options: { defects?: string[]; untagged?: boolean; dialect?: string } = {},
): Promise<ReferenceServer> {
	const { MemoryStore } = await import("./stores/memory.ts")
	return createReferenceServer(options, async (defects) => new MemoryStore(defects))
}

/** SQLite-backed reference server, in-process via `node:sqlite`. */
export async function createSqliteServer(
	options: { defects?: string[]; untagged?: boolean; dialect?: string } = {},
): Promise<ReferenceServer> {
	const { SqlStore } = await import("./stores/sqlite.ts")
	const { nodeSqliteDriver } = await import("./stores/sqlite-driver.ts")
	return createReferenceServer(options, async (defects) =>
		SqlStore.create(defects, await nodeSqliteDriver()),
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
	options: {
		defects?: string[]
		untagged?: boolean
		dialect?: string
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
	return createReferenceServer(options, (defects) =>
		SqlStore.create(
			defects,
			d1Driver({
				accountId: accountId as string,
				apiToken: apiToken as string,
				databaseId: databaseId as string,
			}),
			prefix,
		),
	)
}

/** Postgres-backed reference server. Imported lazily so the driver is only loaded when used. */
export async function createPostgresServer(
	options: { defects?: string[]; untagged?: boolean; dialect?: string } = {},
): Promise<ReferenceServer> {
	const { PgStore } = await import("./stores/postgres.ts")
	return createReferenceServer(options, (defects) => PgStore.create(defects))
}
