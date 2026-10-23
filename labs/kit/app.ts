import { Hono, type Context } from "hono"
import {
	assertJson,
	assertTenant,
	assertWrite,
	authenticate,
	deny,
	HttpError,
	honoPath,
	intQuery,
	isJson,
	KEYS,
	keyOf,
	newId,
	readJson,
	scopeOf,
	type Variables,
} from "./http.ts"
import { QueryError } from "./query.ts"
import { defaults, validateBody } from "./rows.ts"
import { buildSpec } from "./spec.ts"
import { type Grant, type Row, WorldStore } from "./store.ts"
import { collectionPath, entityByName, hasDefect, itemPath, parentIdField, type Entity, type World } from "./types.ts"

type App = Hono<{ Variables: Variables }>
type C = Context<{ Variables: Variables }>

/** One entity mounted on the app: the routes read and write it through the world's store. */
interface Mount {
	app: App
	world: World
	entity: Entity
	store: WorldStore
	list: string
	item: string
	idParam: string
}

export function createWorldApp(world: World, store: WorldStore): App {
	const app = new Hono<{ Variables: Variables }>()
	const spec = buildSpec(world)

	app.onError((error, c) => onError(world, error, c))

	app.get("/v1/openapi/spec", (c) => c.json(spec))
	app.post("/v1/auth/token", async (c) => {
		const body = await readJson(c)
		const key = typeof body["key"] === "string" ? body["key"] : ""
		const principal = KEYS[key]
		if (principal === undefined) throw new HttpError(401, "unauthorized", "unknown key")
		return c.json({ access_token: principal.token, org_id: principal.orgId })
	})

	app.use("/v1/orgs/*", authenticate)
	app.use("/v1/invites/*", authenticate)

	for (const entity of world.entities) {
		mountEntity(app, entity, { store, world })
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

	if (world.jobs === true) mountJobs(app, world, store)

	return app
}

function onError(world: World, error: Error, c: C): Response {
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
}

function mountJobs(app: App, world: World, store: WorldStore): void {
	const job = entityByName(world, "job")
	const artifact = entityByName(world, "artifact")
	app.post("/v1/orgs/:org_id/jobs/start", async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "create")
		assertJson(c)
		const input = validateBody(job, await readJson(c), { phase: "create", world })
		const now = Date.now()
		const row: Row = {
			...defaults(job),
			...input,
			created_at: now,
			id: newId("job", now),
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
				id: newId("art", stamp),
				kind: "red",
				name: `artifact-for-${created["id"]}`,
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

function mountEntity(app: App, entity: Entity, { store, world }: Pick<Mount, "store" | "world">): void {
	const mount: Mount = {
		app,
		entity,
		idParam: `${entity.name}_id`,
		item: honoPath(itemPath(world, entity)),
		list: honoPath(collectionPath(world, entity)),
		store,
		world,
	}
	app.get(mount.list, (c) => listRoute(mount, c))
	app.post(mount.list, (c) => createRoute(mount, c))
	app.get(mount.item, (c) => readRoute(mount, c))
	app.patch(mount.item, (c) => updateRoute(mount, c))
	app.delete(mount.item, (c) => deleteRoute(mount, c))
	if (entity.invite !== true) return
	app.post(`${mount.item}/invites`, (c) => inviteRoute(mount, c))
	app.delete(`${mount.item}/grants/:grant_id`, (c) => revokeRoute(mount, c))
}

async function listRoute({ entity, store, world }: Mount, c: C): Promise<Response> {
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
}

async function createRoute({ entity, store, world }: Mount, c: C): Promise<Response> {
	assertTenant(c)
	assertWrite(c.get("role"), "create")
	if (!isJson(c) && !hasDefect(world, "skip-content-type")) {
		throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
	}
	const idem = c.req.header("idempotency-key")
	const idemKey =
		idem !== undefined && idem !== "" && !hasDefect(world, "drop-idempotency")
			? `${c.get("orgId")}:${entity.name}:${idem}`
			: null
	if (idemKey !== null) {
		const replay = await store.findIdempotent(idemKey)
		if (replay !== null) return c.json(replay, 201)
	}
	const input = validateBody(entity, await readJson(c), { phase: "create", world })
	const created = await store.insert(entity, newRow({ entity, world }, input, c))
	if (idemKey !== null) await store.saveIdempotent(idemKey, created)
	return c.json(created, hasDefect(world, "create-200") ? 200 : 201)
}

function newRow({ entity, world }: { entity: Entity; world: World }, input: Row, c: C): Row {
	const now = Date.now()
	const row: Row = {
		...defaults(entity),
		...input,
		created_at: now,
		id: newId(entity.name.slice(0, 3), now),
		org_id: c.get("orgId"),
		updated_at: now,
	}
	if (entity.softDelete === true) row["deleted_at"] = null
	const parent = parentIdField(entity)
	if (parent !== null) row[parent] = c.req.param(parent)
	for (const derived of entity.derived ?? []) row[derived.name] = 0
	if (hasDefect(world, "drop-create-field")) delete row["note"]
	return row
}

async function readRoute(mount: Mount, c: C): Promise<Response> {
	const { entity, store, world } = mount
	/* Deny the middle rank only so owner GET still works for every other check. */
	if (hasDefect(world, "invert-rank") && c.get("role") === "member") {
		throw new HttpError(403, "forbidden", "role cannot read")
	}
	const id = c.req.param(mount.idParam) as string
	if (c.req.param("org_id") === c.get("orgId")) {
		const own = await store.get(entity, c.get("orgId"), id)
		if (own !== null) return c.json(own)
	}
	const grant = await store.findAcceptedGrant(entity.name, id, keyOf(c))
	if (grant !== null) {
		const shared = await store.get(entity, grant.ownerOrg, id)
		if (shared !== null) return c.json(shared)
	}
	throw await deny(mount, id, c.get("orgId"))
}

async function updateRoute(mount: Mount, c: C): Promise<Response> {
	const { entity, store, world } = mount
	assertTenant(c)
	assertWrite(c.get("role"), "update")
	assertJson(c)
	const patch = validateBody(entity, await readJson(c), { phase: "update", world })
	const id = c.req.param(mount.idParam) as string
	const updated = await store.update(entity, { id, orgId: c.get("orgId") }, patch)
	if (updated === null) throw await deny(mount, id, c.get("orgId"))
	return c.json(updated)
}

async function deleteRoute(mount: Mount, c: C): Promise<Response> {
	assertTenant(c)
	assertWrite(c.get("role"), "delete")
	const id = c.req.param(mount.idParam) as string
	const ok = await mount.store.remove(mount.entity, c.get("orgId"), id)
	if (!ok && !hasDefect(mount.world, "delete-missing-ok")) {
		throw await deny(mount, id, c.get("orgId"))
	}
	return c.body(null, 204)
}

async function inviteRoute(mount: Mount, c: C): Promise<Response> {
	const { entity, store } = mount
	assertTenant(c)
	assertWrite(c.get("role"), "create")
	assertJson(c)
	const key = (await readJson(c))["key"]
	if (typeof key !== "string" || KEYS[key] === undefined) {
		throw new HttpError(400, "invalid_input", "unknown invitee key")
	}
	const id = c.req.param(mount.idParam) as string
	const row = await store.get(entity, c.get("orgId"), id)
	if (row === null) throw await deny(mount, id, c.get("orgId"))
	const grant: Grant = {
		accepted: false,
		entity: entity.name,
		grantId: newId("grn", Date.now()),
		granteeKey: key,
		itemId: id,
		ownerOrg: c.get("orgId"),
		token: `inv_${Math.random().toString(36).slice(2, 12)}`,
	}
	await store.saveGrant(grant)
	return c.json({ grant_id: grant.grantId, token: grant.token }, 201)
}

async function revokeRoute({ entity, idParam, store }: Mount, c: C): Promise<Response> {
	assertTenant(c)
	assertWrite(c.get("role"), "delete")
	const grant = await store.getGrant(c.req.param("grant_id") as string)
	if (grant === null || grant.itemId !== c.req.param(idParam) || grant.entity !== entity.name) {
		throw new HttpError(404, "not_found", "grant not found")
	}
	await store.deleteGrant(grant.grantId)
	return c.json({ revoked: true })
}
