import { Hono } from "hono"
import { QueryError } from "./query.ts"
import { buildSpec } from "./spec.ts"
import { type Grant, type Row, WorldStore } from "./store.ts"
import {
	collectionPath,
	entityByName,
	hasDefect,
	itemPath,
	parentIdField,
	writableFields,
	type Entity,
	type World,
} from "./types.ts"

type Role = "owner" | "member" | "viewer"

const KEYS: Record<string, { orgId: string; token: string; role: Role }> = {
	key_alpha: { orgId: "org_alpha", role: "owner", token: "tok_alpha" },
	key_alpha_member: { orgId: "org_alpha", role: "member", token: "tok_alpha_member" },
	key_alpha_viewer: { orgId: "org_alpha", role: "viewer", token: "tok_alpha_viewer" },
	key_beta: { orgId: "org_beta", role: "owner", token: "tok_beta" },
}

const TOKENS = new Map(Object.values(KEYS).map((p) => [p.token, p] as const))

interface Variables {
	orgId: string
	role: Role
}

export function createWorldApp(world: World, store: WorldStore): Hono<{ Variables: Variables }> {
	const app = new Hono<{ Variables: Variables }>()
	const spec = buildSpec(world)

	app.onError((error, c) => {
		if (error instanceof QueryError || (error instanceof HttpError && error.status < 500)) {
			const status =
				error instanceof QueryError && hasDefect(world, "filter-500")
					? 500
					: error instanceof HttpError
						? error.status
						: 400
			const key = error instanceof HttpError ? error.key : "invalid_input"
			if (hasDefect(world, "wrong-error-shape")) {
				return c.json({ message: error.message }, status as 400)
			}
			return c.json({ error_key: key, message: error.message }, status as 400)
		}
		console.error(error)
		if (hasDefect(world, "wrong-error-shape")) {
			return c.json({ message: "internal error" }, 500)
		}
		return c.json({ error_key: "internal_error", message: "internal error" }, 500)
	})

	app.get("/v1/openapi/spec", (c) => c.json(spec))
	app.post("/v1/auth/token", async (c) => {
		const body = await readJson(c)
		const key = typeof body.key === "string" ? body.key : ""
		const principal = KEYS[key]
		if (principal === undefined) throw new HttpError(401, "unauthorized", "unknown key")
		return c.json({ access_token: principal.token, org_id: principal.orgId })
	})

	const authenticate = async (
		c: { req: { header: (n: string) => string | undefined }; set: (k: "orgId" | "role", v: string) => void },
		next: () => Promise<void>,
	) => {
		const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")
		const principal = TOKENS.get(token)
		if (principal === undefined) throw new HttpError(401, "unauthorized", "missing or unknown token")
		c.set("orgId", principal.orgId)
		c.set("role", principal.role)
		await next()
	}

	app.use("/v1/orgs/*", authenticate)
	app.use("/v1/invites/*", authenticate)

	for (const entity of world.entities) {
		mountEntity(app, world, entity, store)
	}

	if (world.entities.some((e) => e.invite === true)) {
		app.post("/v1/invites/:token/accept", async (c) => {
			const grant = await store.getGrantByToken(c.req.param("token"))
			if (grant === null) throw new HttpError(404, "not_found", "invite not found")
			if (grant.granteeKey !== keyOf(c)) throw new HttpError(403, "forbidden", "invite is not for this principal")
			if (!hasDefect(world, "invite-noop")) await store.saveGrant({ ...grant, accepted: true })
			return c.json({ accepted: true })
		})
	}

	if (world.jobs === true) {
		const job = entityByName(world, "job")
		const artifact = entityByName(world, "artifact")
		app.post("/v1/orgs/:org_id/jobs/start", async (c) => {
			assertTenant(c)
			assertWrite(c.get("role"), "create")
			if (!isJson(c)) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
			const input = validateBody(job, await readJson(c), "create", world)
			const now = Date.now()
			const row: Row = {
				...defaults(job),
				...input,
				created_at: now,
				id: `job_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
				org_id: c.get("orgId"),
				status: hasDefect(world, "async-stall") ? "pending" : "complete",
				updated_at: now,
			}
			const created = await store.insert(job, row)
			if (!hasDefect(world, "effect-noop")) {
				const stamp = Date.now()
				await store.insert(artifact, {
					...defaults(artifact),
					created_at: stamp,
					id: `art_${stamp.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
					kind: "red",
					name: `artifact-for-${created.id}`,
					org_id: c.get("orgId"),
					status: "active",
					updated_at: stamp,
				})
			}
			if (hasDefect(world, "omit-receipt-id")) {
				const { id: _omit, ...receipt } = created
				return c.json(receipt, 202)
			}
			return c.json(created, 202)
		})
	}

	return app
}

function mountEntity(
	app: Hono<{ Variables: Variables }>,
	world: World,
	entity: Entity,
	store: WorldStore,
): void {
	const list = honoPath(collectionPath(world, entity))
	const item = honoPath(itemPath(world, entity))
	const idParam = `${entity.name}_id`

	app.get(list, async (c) => {
		assertTenant(c)
		const qn = world.queryNames ?? {
			filter: "filter",
			limit: "limit",
			order: "order",
			search: "q",
			select: "select",
		}
		const result = await store.list(entity, scopeOf(c, entity), {
			cursor: c.req.query("cursor"),
			filter: c.req.query(qn.filter),
			limit: intQuery(c.req.query(qn.limit)),
			order: c.req.query(qn.order),
			page: intQuery(c.req.query("page")),
			q: c.req.query(qn.search),
			select: c.req.query(qn.select),
		})
		return c.json({
			[entity.plural]: result.items,
			count: result.count,
			hasMore: result.hasMore,
			limit: result.limit,
			nextCursor: result.nextCursor,
			page: result.page,
		})
	})

	app.post(list, async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "create")
		if (!isJson(c) && !hasDefect(world, "skip-content-type")) {
			throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
		}
		const idem = c.req.header("idempotency-key")
		if (idem !== undefined && idem !== "" && !hasDefect(world, "drop-idempotency")) {
			const replay = await store.findIdempotent(`${c.get("orgId")}:${entity.name}:${idem}`)
			if (replay !== null) return c.json(replay, 201)
		}
		const input = validateBody(entity, await readJson(c), "create", world)
		const now = Date.now()
		const row: Row = {
			...defaults(entity),
			...input,
			created_at: now,
			id: `${entity.name.slice(0, 3)}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			org_id: c.get("orgId"),
			updated_at: now,
		}
		if (entity.softDelete === true) row.deleted_at = null
		const parent = parentIdField(entity)
		if (parent !== null) row[parent] = c.req.param(parent)
		for (const derived of entity.derived ?? []) row[derived.name] = 0
		if (hasDefect(world, "drop-create-field")) delete row.note
		const created = await store.insert(entity, row)
		if (idem !== undefined && idem !== "" && !hasDefect(world, "drop-idempotency")) {
			await store.saveIdempotent(`${c.get("orgId")}:${entity.name}:${idem}`, created)
		}
		return c.json(created, hasDefect(world, "create-200") ? 200 : 201)
	})

	app.get(item, async (c) => {
		/* Deny the middle rank only so owner GET still works for every other check. */
		if (hasDefect(world, "invert-rank") && c.get("role") === "member") {
			throw new HttpError(403, "forbidden", "role cannot read")
		}
		const id = c.req.param(idParam)
		if (c.req.param("org_id") === c.get("orgId")) {
			const own = await store.get(entity, c.get("orgId"), id)
			if (own !== null) return c.json(own)
		}
		const grant = await store.findAcceptedGrant(entity.name, id, keyOf(c))
		if (grant !== null) {
			const shared = await store.get(entity, grant.ownerOrg, id)
			if (shared !== null) return c.json(shared)
		}
		throw await deny(world, store, entity, id, c.get("orgId"))
	})

	app.patch(item, async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "update")
		if (!isJson(c)) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
		const patch = validateBody(entity, await readJson(c), "update", world)
		const updated = await store.update(entity, c.get("orgId"), c.req.param(idParam), patch)
		if (updated === null) throw await deny(world, store, entity, c.req.param(idParam), c.get("orgId"))
		return c.json(updated)
	})

	app.delete(item, async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "delete")
		const ok = await store.remove(entity, c.get("orgId"), c.req.param(idParam))
		if (!ok && !hasDefect(world, "delete-missing-ok")) {
			throw await deny(world, store, entity, c.req.param(idParam), c.get("orgId"))
		}
		return c.body(null, 204)
	})

	if (entity.invite !== true) return

	app.post(`${item}/invites`, async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "create")
		if (!isJson(c)) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
		const key = (await readJson(c)).key
		if (typeof key !== "string" || KEYS[key] === undefined) {
			throw new HttpError(400, "invalid_input", "unknown invitee key")
		}
		const id = c.req.param(idParam)
		const row = await store.get(entity, c.get("orgId"), id)
		if (row === null) throw await deny(world, store, entity, id, c.get("orgId"))
		const grant: Grant = {
			accepted: false,
			entity: entity.name,
			grantId: `grn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			granteeKey: key,
			itemId: id,
			ownerOrg: c.get("orgId"),
			token: `inv_${Math.random().toString(36).slice(2, 12)}`,
		}
		await store.saveGrant(grant)
		return c.json({ grant_id: grant.grantId, token: grant.token }, 201)
	})

	app.delete(`${item}/grants/:grant_id`, async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "delete")
		const grant = await store.getGrant(c.req.param("grant_id"))
		if (grant === null || grant.itemId !== c.req.param(idParam) || grant.entity !== entity.name) {
			throw new HttpError(404, "not_found", "grant not found")
		}
		await store.deleteGrant(grant.grantId)
		return c.json({ revoked: true })
	})
}

function defaults(entity: Entity): Row {
	const row: Row = {}
	for (const field of entity.fields) {
		if (field.required === true) continue
		if (field.enum !== undefined) row[field.name] = field.enum[0] ?? null
		else if (field.type === "integer" || field.type === "number") row[field.name] = 0
		else if (field.type === "boolean") row[field.name] = true
		else row[field.name] = field.nullable === true ? null : ""
	}
	return row
}

function validateBody(entity: Entity, input: Row, phase: "create" | "update", world: World): Row {
	const allowed = new Set(writableFields(entity))
	const acceptImmutable = hasDefect(world, "accept-immutable")
	const immutable = acceptImmutable ? new Set<string>() : new Set(["id", "org_id", "created_at"])
	if (acceptImmutable) {
		for (const key of ["id", "org_id", "created_at"]) allowed.add(key)
	}
	for (const key of Object.keys(input)) {
		if (immutable.has(key)) throw new HttpError(400, "invalid_input", `field "${key}" is not writable`)
		if (!allowed.has(key)) throw new HttpError(400, "invalid_input", `unknown field "${key}"`)
	}
	if (phase === "create" && !hasDefect(world, "skip-required")) {
		for (const field of entity.fields) {
			if (field.required !== true) continue
			const value = input[field.name]
			if (value === undefined || value === null || value === "") {
				throw new HttpError(400, "invalid_input", `field "${field.name}" is required`)
			}
		}
	}
	for (const field of entity.fields) {
		const value = input[field.name]
		if (value === undefined || value === null) continue
		if (
			field.enum !== undefined
			&& !field.enum.includes(String(value))
			&& !hasDefect(world, "skip-enum")
		) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be one of ${field.enum.join(", ")}`)
		}
		if (
			field.maxLength !== undefined
			&& typeof value === "string"
			&& value.length > field.maxLength
			&& !hasDefect(world, "skip-max-length")
		) {
			throw new HttpError(400, "invalid_input", `field "${field.name}" exceeds maxLength ${field.maxLength}`)
		}
		if ((field.type === "integer" || field.type === "number") && typeof value !== "number") {
			throw new HttpError(400, "invalid_input", `field "${field.name}" must be a number`)
		}
	}
	return input
}

function scopeOf(c: { req: { param: (n: string) => string }; get: (k: "orgId") => string }, entity: Entity): Record<string, string> {
	const scope: Record<string, string> = { org_id: c.get("orgId") }
	const parent = parentIdField(entity)
	if (parent !== null) scope[parent] = c.req.param(parent)
	return scope
}

function honoPath(path: string): string {
	return path.replace(/\{([^}]+)\}/g, ":$1")
}

function keyOf(c: { req: { header: (n: string) => string | undefined } }): string {
	const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")
	const found = Object.entries(KEYS).find(([, principal]) => principal.token === token)
	return found?.[0] ?? ""
}

function assertWrite(role: Role, kind: "create" | "update" | "delete"): void {
	if (kind === "delete" && role !== "owner") throw new HttpError(403, "forbidden", "role cannot delete")
	if ((kind === "create" || kind === "update") && role === "viewer") {
		throw new HttpError(403, "forbidden", "role cannot write")
	}
}

function assertTenant(c: { req: { param: (n: string) => string }; get: (k: "orgId") => string }): void {
	if (c.req.param("org_id") !== c.get("orgId")) {
		throw new HttpError(404, "not_found", "no route for this organisation")
	}
}

async function deny(
	world: World,
	store: WorldStore,
	entity: Entity,
	id: string,
	orgId: string,
): Promise<HttpError> {
	const exists = await store.existsElsewhere(entity, id, orgId)
	if (hasDefect(world, "oracle-status") && exists) {
		return new HttpError(403, "forbidden", `${entity.name} ${id} forbidden`)
	}
	return new HttpError(404, "not_found", `${entity.name} ${id} not found`)
}

function isJson(c: { req: { header: (n: string) => string | undefined } }): boolean {
	return (c.req.header("content-type") ?? "").includes("application/json")
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Row> {
	const body = await c.req.json().catch(() => {
		throw new HttpError(400, "invalid_input", "request body must be a JSON object")
	})
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "invalid_input", "request body must be a JSON object")
	}
	return body as Row
}

function intQuery(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined
	const n = Number(raw)
	if (!Number.isFinite(n)) throw new HttpError(400, "invalid_input", "query parameter must be numeric")
	return n
}

class HttpError extends Error {
	status: number
	key: string
	constructor(status: number, key: string, message: string) {
		super(message)
		this.status = status
		this.key = key
	}
}
