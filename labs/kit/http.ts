import type { Entity, World } from "./types.ts"
import { hasDefect, parentIdField } from "./types.ts"
import type { Row, WorldStore } from "./store.ts"

/* The request side of a world app: principals, guards, and reading the request. */

export type Role = "owner" | "member" | "viewer"

export interface Variables {
	orgId: string
	role: Role
}

export const KEYS: Record<string, { orgId: string; token: string; role: Role }> = {
	key_alpha: { orgId: "org_alpha", role: "owner", token: "tok_alpha" },
	key_alpha_member: { orgId: "org_alpha", role: "member", token: "tok_alpha_member" },
	key_alpha_viewer: { orgId: "org_alpha", role: "viewer", token: "tok_alpha_viewer" },
	key_beta: { orgId: "org_beta", role: "owner", token: "tok_beta" },
}

const TOKENS = new Map(Object.values(KEYS).map((p) => [p.token, p] as const))

type Headers = { req: { header: (n: string) => string | undefined } }
type Tenant = { req: { param: (n: string) => string | undefined }; get: (k: "orgId") => string }

export class HttpError extends Error {
	status: number
	key: string
	constructor(status: number, key: string, message: string) {
		super(message)
		this.status = status
		this.key = key
	}
}

export const authenticate = async (
	c: Headers & { set: (k: "orgId" | "role", v: string) => void },
	next: () => Promise<void>,
): Promise<void> => {
	const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")
	const principal = TOKENS.get(token)
	if (principal === undefined) throw new HttpError(401, "unauthorized", "missing or unknown token")
	c.set("orgId", principal.orgId)
	c.set("role", principal.role)
	await next()
}

export function scopeOf(c: Tenant, entity: Entity): Record<string, string> {
	const scope: Record<string, string> = { org_id: c.get("orgId") }
	const parent = parentIdField(entity)
	if (parent !== null) scope[parent] = c.req.param(parent) as string
	return scope
}

export function honoPath(path: string): string {
	return path.replace(/\{([^}]+)\}/g, ":$1")
}

export function keyOf(c: Headers): string {
	const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "")
	const found = Object.entries(KEYS).find(([, principal]) => principal.token === token)
	return found?.[0] ?? ""
}

export function assertWrite(role: Role, kind: "create" | "update" | "delete"): void {
	if (kind === "delete" && role !== "owner") throw new HttpError(403, "forbidden", "role cannot delete")
	if ((kind === "create" || kind === "update") && role === "viewer") {
		throw new HttpError(403, "forbidden", "role cannot write")
	}
}

export function assertTenant(c: Tenant): void {
	if (c.req.param("org_id") !== c.get("orgId")) {
		throw new HttpError(404, "not_found", "no route for this organization")
	}
}

/** The error for an id this org cannot see: 404, or 403 under the oracle defect when another org has it. */
export async function deny(
	mount: { world: World; store: WorldStore; entity: Entity },
	id: string,
	orgId: string,
): Promise<HttpError> {
	const { entity, store, world } = mount
	const exists = await store.existsElsewhere(entity, id, orgId)
	if (hasDefect(world, "oracle-status") && exists) {
		return new HttpError(403, "forbidden", `${entity.name} ${id} forbidden`)
	}
	return new HttpError(404, "not_found", `${entity.name} ${id} not found`)
}

export function isJson(c: Headers): boolean {
	return (c.req.header("content-type") ?? "").includes("application/json")
}

export function assertJson(c: Headers): void {
	if (!isJson(c)) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json")
}

export async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Row> {
	const body = await c.req.json().catch(() => {
		throw new HttpError(400, "invalid_input", "request body must be a JSON object")
	})
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "invalid_input", "request body must be a JSON object")
	}
	return body as Row
}

export function intQuery(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined
	const n = Number(raw)
	if (!Number.isFinite(n)) throw new HttpError(400, "invalid_input", "query parameter must be numeric")
	return n
}

/** A fresh random id: `<prefix>_<time base36>_<6 random chars>`. */
export function newId(prefix: string, now: number): string {
	return `${prefix}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
