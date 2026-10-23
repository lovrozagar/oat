import type { SecurityConfig } from "../../../config/types/security.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Answer, Responder } from "../../checks/__fixtures__/harness.ts"
import { FindingCollector } from "../../finding.ts"
import { GradeLedger } from "../../grades.ts"
import { contextOf, optionsFor, type Seen } from "../../run/__fixtures__/api.ts"
import type { RunContext } from "../../run/context.ts"
import { enrollerOf } from "../../run/disposable.ts"
import type { RunOptions } from "../../run/types.ts"
import type { DisposableInput, Session } from "../types.ts"

/*
 * A socket-free accounts API for destructive operations: sign up, read yourself, log out, renew,
 * and API keys listed and deleted one by one. Every request goes through the run's own client,
 * store and credential source over a scripted transport, so a second user is signed up, held and
 * placed as it would be against a server. The suite caller holds the static token `alpha`.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
	properties,
	required,
	type: "object",
})
const tokens = object({ access_token: { type: "string" }, refresh_token: { type: "string" } }, ["access_token"])
const key = object({ id: { type: "string" } })
const keyParam = { in: "path", name: "key_id", required: true, schema: { type: "string" } }

/** The bearer scheme every operation takes unless it says otherwise. */
const BEARER = { securitySchemes: { session: { scheme: "bearer", type: "http" } } }

/** The accounts document; `extra` adds or replaces paths, and `components` replaces its schemes. */
export function accountsDoc(extra: Record<string, unknown> = {}, components: unknown = BEARER): OpenApiDocument {
	const open = { security: [] }
	return {
		components,
		info: { title: "accounts", version: "1" },
		openapi: "3.1.0",
		security: [{ [Object.keys((components as typeof BEARER).securitySchemes)[0] as string]: [] }],
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
					...open,
					requestBody: json(object({ refresh_token: { type: "string" } }, ["refresh_token"])),
					responses: { "200": { description: "renewed" } },
				},
			},
			"/v1/register": {
				post: {
					operationId: "auth.register",
					...open,
					requestBody: json(object({ email: { format: "email", type: "string" } }, ["email"])),
					responses: { "201": { description: "created", ...json(tokens) } },
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

/** The accounts API over `state`: a token is read from a bearer `authorization`, or an `x-api-key`. */
export function accountsApi(state: Accounts): Responder {
	return (method, path, options) => {
		const fixed = state.answers?.[`${method} ${path}`]
		if (fixed !== undefined) return fixed
		const headers = (options.headers ?? {}) as Record<string, string>
		const token = headers["x-api-key"] ?? (headers["authorization"] ?? "").replace(/^Bearer /, "")
		const body = (options.body ?? {}) as Record<string, unknown>
		return route(state, { body, method, path, token })
	}
}

interface Hit {
	token: string
	body: Record<string, unknown>
	method: string
	path: string
}

/* Each route of the accounts API, by `METHOD /path`. */
const ROUTES: Record<string, (state: Accounts, hit: Hit) => Answer> = {
	"GET /v1/keys": (state) => ({ body: { keys: state.keys }, status: 200 }),
	"GET /v1/me": (state, hit) =>
		state.tokens.has(hit.token) ? { body: { name: "Ada" }, status: 200 } : { status: 401 },
	"POST /v1/logout": (state, hit) => {
		if (state.killCaller === true) state.tokens.clear()
		else if (state.keepSession !== true) state.tokens.delete(hit.token)
		if (typeof hit.body["refresh_token"] === "string") state.revoked.add(hit.body["refresh_token"])
		return { body: { ok: true }, status: 200 }
	},
	"POST /v1/refresh": (state, hit) => {
		const refresh = hit.body["refresh_token"]
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

/** Fields to set; one given as `undefined` is left out, so a test can drop a default. */
export type Overrides<T> = { [K in keyof T]?: T[K] | undefined }

function overriding<T extends object>(base: T, fields: Overrides<T>): T {
	const out: Record<string, unknown> = { ...base, ...fields }
	for (const [name, value] of Object.entries(fields)) if (value === undefined) delete out[name]
	return out as T
}

/**
 * The scheme's credential: a session the signup answers with, which the suite caller holds as the
 * static `alpha`. Its login steps are never run here, since each second user adopts its signup's token.
 */
export function sessionSecurity(scheme = "session"): SecurityConfig {
	return { [scheme]: { login: { from: "$.access_token", steps: [{ operationId: "auth.register" }] } } }
}

/** A staged run: the input `runDisposableOps` takes, the run it came from, and what the transport saw since. */
export interface Staged {
	input: DisposableInput
	ctx: RunContext
	seen: Seen[]
}

/** What a staged run overrides: fields of the input, and the run's options. */
export interface Staging {
	input?: Overrides<DisposableInput>
	run?: Partial<RunOptions>
}

/**
 * The input `runDisposableOps` takes over `document` and `respond`, as the run builds it, and what
 * the transport saw once the run was set up.
 */
export async function stageOf(document: OpenApiDocument, respond: Responder, staging: Staging = {}): Promise<Staged> {
	const serving: Responder = (method, path, options) =>
		path === "/openapi.json" ? { body: document, status: 200 } : respond(method, path, options)
	const scheme = Object.keys(document.components?.securitySchemes ?? {})[0] as string
	const options = optionsFor(serving, {
		principals: { alpha: { security: { [scheme]: { static: "alpha" } } } },
		security: sessionSecurity(scheme),
		...staging.run,
	})
	const ctx = await contextOf(options)
	const base: DisposableInput = {
		checksRun: new Set(),
		client: ctx.client,
		enroll: enrollerOf(ctx),
		findings: new FindingCollector(),
		grades: new GradeLedger(),
		inScope: () => true,
		mode: "full",
		model: ctx.model,
		nonce: "n0",
		principal: "alpha",
		seed: 1,
	}
	/* What setting the run up sent (its document) is not the disposable stage's. */
	options.seen.splice(0)
	return { ctx, input: overriding(base, staging.input ?? {}), seen: options.seen }
}

/** A second user holding `token`, bound in the staged run's store as `disposable-<token>`. */
export async function sessionHolding(staged: Staged, token: string, fields: Partial<Session> = {}): Promise<Session> {
	const principal = `disposable-${token}`
	const scheme = [...staged.ctx.model.schemes.keys()][0] as string
	staged.ctx.store.enroll(principal, {})
	await staged.ctx.store.adopt({ principal, scheme, value: token })
	return { known: {}, principal, scope: {}, ...fields }
}
