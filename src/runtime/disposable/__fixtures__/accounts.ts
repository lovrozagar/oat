import type { AuthFlow } from "../../../config/types/principals.ts"
import { Client } from "../../../client/client.ts"
import { Redactor } from "../../../security/redact.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Answer, Responder } from "../../checks/__fixtures__/harness.ts"
import { modelOf } from "../../checks/__fixtures__/harness.ts"
import { FindingCollector } from "../../finding.ts"
import { GradeLedger } from "../../grades.ts"
import { BASE, type Seen, transport } from "../../run/__fixtures__/api.ts"
import type { DisposableInput } from "../types.ts"

/*
 * A socket-free accounts API for destructive operations: sign up, read yourself, log out, renew,
 * and API keys listed and deleted one by one. Every request goes through a real client over a
 * scripted transport, so a signup flow runs as it would against a server.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
	properties,
	required,
	type: "object",
})
const token = object({ access_token: { type: "string" }, refresh_token: { type: "string" } }, ["access_token"])
const key = object({ id: { type: "string" } })
const keyParam = { in: "path", name: "key_id", required: true, schema: { type: "string" } }

/** The accounts document; `extra` adds or replaces paths. */
export function accountsDoc(extra: Record<string, unknown> = {}): OpenApiDocument {
	return {
		info: { title: "accounts", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/keys": {
				get: {
					operationId: "keys.list",
					responses: { "200": { description: "ok", ...json(object({ keys: { items: key, type: "array" } })) } },
				},
			},
			"/v1/keys/{key_id}": {
				delete: {
					operationId: "keys.delete",
					parameters: [keyParam],
					responses: { "204": { description: "gone" } },
					"x-destructive": true,
				},
			},
			"/v1/logout": {
				post: {
					operationId: "auth.logout",
					requestBody: json(object({ refresh_token: { type: "string" } })),
					responses: { "200": { description: "ok" } },
					"x-destructive": true,
					"x-invalidate": ["GET /v1/me"],
				},
			},
			"/v1/me": {
				get: {
					operationId: "profile.read",
					responses: { "200": { description: "ok", ...json(object({ name: { type: "string" } })) } },
					"x-entity": { action: "read", identity: "self", name: "profile" },
				},
			},
			"/v1/refresh": {
				post: {
					operationId: "auth.refresh",
					requestBody: json(object({ refresh_token: { type: "string" } }, ["refresh_token"])),
					responses: { "200": { description: "renewed" } },
				},
			},
			"/v1/register": {
				post: {
					operationId: "auth.register",
					requestBody: json(object({ email: { format: "email", type: "string" } }, ["email"])),
					responses: { "201": { description: "created", ...json(token) } },
					"x-fresh-principal": true,
				},
			},
			...extra,
		},
	} as unknown as OpenApiDocument
}

/** How the accounts API misbehaves, and what it holds. */
export interface Accounts {
	/** Live access tokens. The suite caller holds `alpha`. */
	tokens: Set<string>
	/** Refresh tokens a logout revoked. */
	revoked: Set<string>
	keys: Array<{ id: string }>
	issued: number
	killCaller?: boolean
	keepSession?: boolean
	refreshLives?: boolean
	keysStay?: boolean
	/** Answers that replace the API's own, by `METHOD /path`. */
	answers?: Record<string, Answer>
}

export function accounts(fields: Partial<Accounts> = {}): Accounts {
	return { issued: 0, keys: [{ id: "k1" }], revoked: new Set(), tokens: new Set(["alpha"]), ...fields }
}

/** The accounts API over `state`. */
export function accountsApi(state: Accounts): Responder {
	return (method, path, options) => {
		const fixed = state.answers?.[`${method} ${path}`]
		if (fixed !== undefined) return fixed
		const headers = (options.headers ?? {}) as Record<string, string>
		const bearer = (headers.authorization ?? "").replace(/^Bearer /, "")
		const body = (options.body ?? {}) as Record<string, unknown>
		return route(state, { bearer, body, method, path })
	}
}

interface Hit {
	bearer: string
	body: Record<string, unknown>
	method: string
	path: string
}

/* Each route of the accounts API, by `METHOD /path`. */
const ROUTES: Record<string, (state: Accounts, hit: Hit) => Answer> = {
	"GET /v1/keys": (state) => ({ body: { keys: state.keys }, status: 200 }),
	"GET /v1/me": (state, hit) =>
		state.tokens.has(hit.bearer) ? { body: { name: "Ada" }, status: 200 } : { status: 401 },
	"POST /v1/logout": (state, hit) => {
		if (state.killCaller === true) state.tokens.clear()
		else if (state.keepSession !== true) state.tokens.delete(hit.bearer)
		if (typeof hit.body.refresh_token === "string") state.revoked.add(hit.body.refresh_token)
		return { body: { ok: true }, status: 200 }
	},
	"POST /v1/refresh": (state, hit) => {
		const refresh = hit.body.refresh_token
		const alive = state.refreshLives === true || (typeof refresh === "string" && !state.revoked.has(refresh))
		return alive ? { body: { ok: true }, status: 200 } : { status: 401 }
	},
	"POST /v1/register": (state) => {
		state.issued += 1
		state.tokens.add(`t${state.issued}`)
		return { body: { access_token: `t${state.issued}`, refresh_token: `r${state.issued}` }, status: 201 }
	},
}

function route(state: Accounts, hit: Hit): Answer | undefined {
	const handler = ROUTES[`${hit.method} ${hit.path}`]
	if (handler !== undefined) return handler(state, hit)
	const deleted = /^\/v1\/keys\/([^/]+)$/.exec(hit.path)?.[1]
	if (hit.method !== "DELETE" || deleted === undefined) return undefined
	if (state.keysStay !== true) state.keys = state.keys.filter((row) => row.id !== deleted)
	return { status: 204 }
}

/** The suite principal's flow: sign up an address, keep its refresh token, renew with it. */
export function signupFlow(email = "suite@example.test"): AuthFlow {
	return {
		credentialFrom: "$.access_token",
		refresh: { steps: [{ body: { refresh_token: "{refreshToken}" }, operationId: "auth.refresh" }] },
		steps: [
			{
				bind: { address: email },
				body: { email: "{address}", plan: "free" },
				operationId: "auth.register",
				saveAs: { credential: "$.access_token", refreshToken: "$.refresh_token" },
			},
		],
	} as AuthFlow
}

/** Fields to set; one given as `undefined` is left out, so a test can drop a default. */
export type Overrides<T> = { [K in keyof T]?: T[K] | undefined }

function overriding<T extends object>(base: T, fields: Overrides<T>): T {
	const out: Record<string, unknown> = { ...base, ...fields }
	for (const [name, value] of Object.entries(fields)) if (value === undefined) delete out[name]
	return out as T
}

/** The input `runDisposableOps` takes over `document` and `respond`, and what the transport saw. */
export function stageOf(
	document: OpenApiDocument,
	respond: Responder,
	fields: Overrides<DisposableInput> = {},
): { input: DisposableInput; seen: Seen[] } {
	const { fetch, seen } = transport(respond)
	const client = new Client({ baseUrl: BASE, network: { fetchImpl: fetch, retries: 0 }, redactor: new Redactor() })
	const base: DisposableInput = {
		auth: () => ({ authorization: "Bearer alpha" }),
		checksRun: new Set(),
		client,
		findings: new FindingCollector(),
		grades: new GradeLedger(),
		inScope: () => true,
		mode: "full",
		model: modelOf(document),
		nonce: "n0",
		seed: 1,
	}
	return { input: overriding(base, fields), seen }
}
