import { Hono } from "hono"
import { QueryError } from "./query.ts"
import { Store, type Row } from "./store.ts"

type Role = "owner" | "member" | "viewer"

const KEYS: Record<string, { orgId: string; token: string; role: Role }> = {
	key_alpha: { orgId: "org_alpha", role: "owner", token: "tok_alpha" },
	key_alpha_member: { orgId: "org_alpha", role: "member", token: "tok_alpha_member" },
	key_alpha_viewer: { orgId: "org_alpha", role: "viewer", token: "tok_alpha_viewer" },
	key_beta: { orgId: "org_beta", role: "owner", token: "tok_beta" },
}

const TOKENS = new Map(Object.values(KEYS).map((p) => [p.token, p] as const))

const IMMUTABLE = new Set(["id", "org_id", "created_at"])
const ENUMS: Record<string, readonly string[]> = { status: ["draft", "published", "archived"] }
const MAX_LEN: Record<string, number> = { title: 128, slug: 64, body: 2000 }

interface Variables {
	orgId: string
	role: Role
}

interface Grant {
	accepted: boolean
	articleId: string
	grantId: string
	granteeKey: string
	ownerOrg: string
	token: string
}

export function createApp(store: Store): Hono<{ Variables: Variables }> {
	const app = new Hono<{ Variables: Variables }>()
	const grants = new Map<string, Grant>()

	app.onError((error, c) => {
		if (error instanceof QueryError || (error instanceof HttpError && error.status < 500)) {
			const status = error instanceof HttpError ? error.status : 400
			const key = error instanceof HttpError ? error.key : "invalid_input"
			return c.json({ error_key: key, message: error.message }, status)
		}
		console.error(error)
		return c.json({ error_key: "internal_error", message: "internal error" }, 500)
	})

	app.get("/v1/openapi/spec", async (c) => {
		const { readFile } = await import("node:fs/promises")
		const { dirname, join } = await import("node:path")
		const { fileURLToPath } = await import("node:url")
		const yaml = await readFile(join(dirname(fileURLToPath(import.meta.url)), "openapi.yaml"), "utf8")
		/* Served as YAML; oat's loader accepts YAML and JSON. */
		return c.body(yaml, 200, { "content-type": "application/yaml" })
	})

	app.post("/v1/auth/token", async (c) => {
		const body = await readJson(c)
		const key = typeof body.key === "string" ? body.key : ""
		const principal = KEYS[key]
		if (principal === undefined) throw new HttpError(401, "unauthorized", "unknown key")
		return c.json({ access_token: principal.token, org_id: principal.orgId })
	})

	const authenticate = async (c: { req: { header: (n: string) => string | undefined }; set: (k: "orgId" | "role", v: string) => void }, next: () => Promise<void>) => {
		const header = c.req.header("authorization") ?? ""
		const token = header.replace(/^Bearer\s+/i, "")
		const principal = TOKENS.get(token)
		if (principal === undefined) throw new HttpError(401, "unauthorized", "missing or unknown token")
		c.set("orgId", principal.orgId)
		c.set("role", principal.role)
		await next()
	}

	app.use("/v1/orgs/*", authenticate)
	app.use("/v1/invites/*", authenticate)

	app.get("/v1/orgs/:org_id/articles", async (c) => {
		assertTenant(c)
		const result = await store.list(c.get("orgId"), {
			cursor: c.req.query("cursor"),
			filter: c.req.query("filter"),
			limit: intQuery(c.req.query("limit")),
			order: c.req.query("order"),
			page: intQuery(c.req.query("page")),
			q: c.req.query("q"),
			select: c.req.query("select"),
		})
		return c.json({
			articles: result.items,
			count: result.count,
			hasMore: result.hasMore,
			limit: result.limit,
			nextCursor: result.nextCursor,
			page: result.page,
		})
	})

	app.post("/v1/orgs/:org_id/articles", async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "create")
		if (!isJson(c)) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
		const idem = c.req.header("idempotency-key")
		if (idem !== undefined && idem !== "") {
			const replay = await store.findIdempotent(`${c.get("orgId")}:${idem}`)
			if (replay !== null) return c.json(replay, 201)
		}
		const input = validateBody(await readJson(c), "create")
		const now = Date.now()
		const row: Row = {
			body: input.body ?? null,
			comment_count: 0,
			created_at: now,
			deleted_at: null,
			id: `art_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			org_id: c.get("orgId"),
			position: typeof input.position === "number" ? input.position : 0,
			slug: input.slug ?? null,
			status: input.status ?? "draft",
			title: input.title,
			updated_at: now,
		}
		const created = await store.insert(row)
		if (idem !== undefined && idem !== "") {
			await store.saveIdempotent(`${c.get("orgId")}:${idem}`, created)
		}
		return c.json(created, 201)
	})

	app.get("/v1/orgs/:org_id/articles/:article_id", async (c) => {
		const id = c.req.param("article_id")
		if (c.req.param("org_id") === c.get("orgId")) {
			const own = await store.get(c.get("orgId"), id)
			if (own !== null) return c.json(own)
		}
		const grant = [...grants.values()].find(
			(item) => item.articleId === id && item.granteeKey === keyOf(c) && item.accepted,
		)
		if (grant !== undefined) {
			const shared = await store.get(grant.ownerOrg, id)
			if (shared !== null) return c.json(shared)
		}
		throw await deny(store, id, c.get("orgId"))
	})

	app.post("/v1/orgs/:org_id/articles/:article_id/invites", async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "create")
		if (!isJson(c)) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
		const key = (await readJson(c)).key
		if (typeof key !== "string" || KEYS[key] === undefined) {
			throw new HttpError(400, "invalid_input", "unknown invitee key")
		}
		const id = c.req.param("article_id")
		const row = await store.get(c.get("orgId"), id)
		if (row === null) throw await deny(store, id, c.get("orgId"))
		const grant: Grant = {
			accepted: false,
			articleId: id,
			grantId: `grn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			granteeKey: key,
			ownerOrg: c.get("orgId"),
			token: `inv_${Math.random().toString(36).slice(2, 12)}`,
		}
		grants.set(grant.grantId, grant)
		return c.json({ grant_id: grant.grantId, token: grant.token }, 201)
	})

	app.post("/v1/invites/:token/accept", async (c) => {
		const grant = [...grants.values()].find((item) => item.token === c.req.param("token"))
		if (grant === undefined) throw new HttpError(404, "not_found", "invite not found")
		if (grant.granteeKey !== keyOf(c)) throw new HttpError(403, "forbidden", "invite is not for this principal")
		grant.accepted = true
		return c.json({ accepted: true })
	})

	app.delete("/v1/orgs/:org_id/articles/:article_id/grants/:grant_id", async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "delete")
		const grant = grants.get(c.req.param("grant_id"))
		if (grant === undefined || grant.articleId !== c.req.param("article_id")) {
			throw new HttpError(404, "not_found", "grant not found")
		}
		grants.delete(grant.grantId)
		return c.json({ revoked: true })
	})

	app.patch("/v1/orgs/:org_id/articles/:article_id", async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "update")
		if (!isJson(c)) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
		const patch = validateBody(await readJson(c), "update")
		const updated = await store.update(c.get("orgId"), c.req.param("article_id"), patch)
		if (updated === null) throw await deny(store, c.req.param("article_id"), c.get("orgId"))
		return c.json(updated)
	})

	app.delete("/v1/orgs/:org_id/articles/:article_id", async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "delete")
		const ok = await store.softDelete(c.get("orgId"), c.req.param("article_id"))
		if (!ok) throw await deny(store, c.req.param("article_id"), c.get("orgId"))
		return c.body(null, 204)
	})

	app.get("/v1/orgs/:org_id/articles/:article_id/comments", async (c) => {
		assertTenant(c)
		const article = await store.get(c.get("orgId"), c.req.param("article_id"))
		if (article === null) throw await deny(store, c.req.param("article_id"), c.get("orgId"))
		const result = await store.listComments(c.get("orgId"), c.req.param("article_id"), {
			cursor: c.req.query("cursor"),
			filter: c.req.query("filter"),
			limit: intQuery(c.req.query("limit")),
			order: c.req.query("order"),
			page: intQuery(c.req.query("page")),
			q: c.req.query("q"),
			select: c.req.query("select"),
		})
		return c.json({
			comments: result.items,
			count: result.count,
			hasMore: result.hasMore,
			limit: result.limit,
			nextCursor: result.nextCursor,
			page: result.page,
		})
	})

	app.post("/v1/orgs/:org_id/articles/:article_id/comments", async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "create")
		if (!isJson(c)) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
		const article = await store.get(c.get("orgId"), c.req.param("article_id"))
		if (article === null) throw await deny(store, c.req.param("article_id"), c.get("orgId"))
		const input = await readJson(c)
		const body = input.body
		if (typeof body !== "string" || body === "") {
			throw new HttpError(400, "invalid_input", 'field "body" is required')
		}
		if (body.length > 2000) throw new HttpError(400, "invalid_input", 'field "body" exceeds maxLength 2000')
		const kind = typeof input.kind === "string" ? input.kind : "note"
		if (kind !== "note" && kind !== "question") {
			throw new HttpError(400, "invalid_input", 'field "kind" must be one of note, question')
		}
		if (input.author !== undefined && input.author !== null && typeof input.author !== "string") {
			throw new HttpError(400, "invalid_input", 'field "author" must be a string')
		}
		if (typeof input.author === "string" && input.author.length > 64) {
			throw new HttpError(400, "invalid_input", 'field "author" exceeds maxLength 64')
		}
		const now = Date.now()
		const row: Row = {
			article_id: c.req.param("article_id"),
			author: typeof input.author === "string" ? input.author : null,
			body,
			created_at: now,
			id: `cmt_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
			kind,
			org_id: c.get("orgId"),
			updated_at: now,
		}
		return c.json(await store.insertComment(row), 201)
	})

	app.get("/v1/orgs/:org_id/articles/:article_id/comments/:comment_id", async (c) => {
		assertTenant(c)
		const row = await store.getComment(c.get("orgId"), c.req.param("article_id"), c.req.param("comment_id"))
		if (row === null) throw new HttpError(404, "not_found", "comment not found")
		return c.json(row)
	})

	app.patch("/v1/orgs/:org_id/articles/:article_id/comments/:comment_id", async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "update")
		if (!isJson(c)) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
		const input = await readJson(c)
		const patch: Row = {}
		if (input.body !== undefined) {
			if (typeof input.body !== "string" || input.body === "") {
				throw new HttpError(400, "invalid_input", 'field "body" must be a non-empty string')
			}
			if (input.body.length > 2000) throw new HttpError(400, "invalid_input", 'field "body" exceeds maxLength 2000')
			patch.body = input.body
		}
		if (input.author !== undefined) {
			if (input.author !== null && typeof input.author !== "string") {
				throw new HttpError(400, "invalid_input", 'field "author" must be a string')
			}
			if (typeof input.author === "string" && input.author.length > 64) {
				throw new HttpError(400, "invalid_input", 'field "author" exceeds maxLength 64')
			}
			patch.author = input.author
		}
		if (input.kind !== undefined) {
			if (input.kind !== "note" && input.kind !== "question") {
				throw new HttpError(400, "invalid_input", 'field "kind" must be one of note, question')
			}
			patch.kind = input.kind
		}
		const updated = await store.updateComment(
			c.get("orgId"),
			c.req.param("article_id"),
			c.req.param("comment_id"),
			patch,
		)
		if (updated === null) throw new HttpError(404, "not_found", "comment not found")
		return c.json(updated)
	})

	app.delete("/v1/orgs/:org_id/articles/:article_id/comments/:comment_id", async (c) => {
		assertTenant(c)
		assertWrite(c.get("role"), "delete")
		const ok = await store.deleteComment(c.get("orgId"), c.req.param("article_id"), c.req.param("comment_id"))
		if (!ok) throw new HttpError(404, "not_found", "comment not found")
		return c.body(null, 204)
	})

	return app
}

function keyOf(c: { req: { header: (n: string) => string | undefined } }): string {
	const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")
	const found = Object.entries(KEYS).find(([, principal]) => principal.token === token)
	return found?.[0] ?? ""
}

function assertWrite(role: Role, kind: "create" | "update" | "delete"): void {
	if (kind === "delete" && role !== "owner") {
		throw new HttpError(403, "forbidden", "role cannot delete")
	}
	if ((kind === "create" || kind === "update") && role === "viewer") {
		throw new HttpError(403, "forbidden", "role cannot write")
	}
}

function assertTenant(c: { req: { param: (n: string) => string }; get: (k: "orgId") => string }): void {
	if (c.req.param("org_id") !== c.get("orgId")) {
		throw new HttpError(404, "not_found", "no route for this organisation")
	}
}

async function deny(store: Store, id: string, orgId: string): Promise<HttpError> {
	/* Same 404 whether the row is missing or belongs to someone else. */
	await store.existsElsewhere(id, orgId)
	return new HttpError(404, "not_found", `article ${id} not found`)
}

function isJson(c: { req: { header: (n: string) => string | undefined } }): boolean {
	const type = c.req.header("content-type") ?? ""
	return type.includes("application/json")
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

function validateBody(input: Row, phase: "create" | "update"): Row {
	const allowed = new Set(["title", "slug", "status", "body", "position"])
	for (const key of Object.keys(input)) {
		if (IMMUTABLE.has(key)) throw new HttpError(400, "invalid_input", `field "${key}" is not writable`)
		if (!allowed.has(key)) throw new HttpError(400, "invalid_input", `unknown field "${key}"`)
	}
	if (phase === "create" && (input.title === undefined || input.title === null || input.title === "")) {
		throw new HttpError(400, "invalid_input", 'field "title" is required')
	}
	for (const [field, members] of Object.entries(ENUMS)) {
		const value = input[field]
		if (value === undefined || value === null) continue
		if (!members.includes(String(value))) {
			throw new HttpError(400, "invalid_input", `field "${field}" must be one of ${members.join(", ")}`)
		}
	}
	for (const [field, max] of Object.entries(MAX_LEN)) {
		const value = input[field]
		if (typeof value === "string" && value.length > max) {
			throw new HttpError(400, "invalid_input", `field "${field}" exceeds maxLength ${max}`)
		}
	}
	if (input.position !== undefined && input.position !== null && typeof input.position !== "number") {
		throw new HttpError(400, "invalid_input", 'field "position" must be a number')
	}
	return input
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
