/**
 * Credential acquisition and lifecycle.
 *
 * oat knows nothing about any login route. A principal declares a chain of steps; each step is
 * an operation from the spec (or a raw request), values flow forward by JSON path, and anything
 * delivered outside HTTP — verification tokens, OTPs, magic links — comes from a hook the caller
 * writes. That hook is the entire backend-coupling surface.
 */

import type {
	AuthFlow,
	AuthStep,
	HookAuth,
	Hooks,
	OperationStep,
	PrincipalAuth,
	PrincipalAuthResult,
	RequestStep,
} from "../config/define-config.ts"
import { isHookAuth } from "../config/define-config.ts"
import { requestContent } from "../spec/collection.ts"
import type { SpecModel } from "../spec/graph.ts"
import { encodeRequest } from "./body.ts"
import type { Client, Exchange } from "./client.ts"
import { type BackoffConfig, isAbsentValue, pollWithBackoff, resolveBackoff, worstCaseWaitMs } from "./poll.ts"

/* The flow shape is defined once, in the public config — the runtime consumes it rather than
 * declaring a parallel copy that can drift out of agreement with what users actually write. */
export type AcquireSpec = AuthFlow

export const DEFAULT_REFRESH_BUFFER_MS = 30_000

/** Signup acquire without `auth.refresh` — re-running `steps` would register again. */
export class AuthRefreshRequiredError extends Error {
	readonly code = "AUTH_REFRESH_REQUIRED" as const

	constructor(principalId: string) {
		super(
			`oat: principal "${principalId}" cannot refresh — its acquire steps register a new account, ` +
				"and re-running them is not a refresh. Declare auth.refresh with the refresh-token operation.",
		)
		this.name = "AuthRefreshRequiredError"
	}
}

export interface PrincipalRuntime {
	id: string
	headers: () => Record<string, string>
	/** Address this principal was provisioned under, for cascade teardown. */
	address: string | null
	/** Values bound during acquisition — roots discovered from the credential live here too. */
	scope: Record<string, string>
	/**
	 * Renew when `expiresAt - now <= refreshBufferMs`, or immediately when `force` is set (401).
	 * `expiresAt === null` never proactive-refreshes. Single-flight per principal.
	 */
	refreshIfStale: (force?: boolean) => Promise<void>
	/** Forces reacquisition, used when a control probe proves the credential died early. */
	reacquire: () => Promise<void>
	expiresAt: number | null
	/** True when `headers` carry a credential this principal issued (current or previous). */
	matches: (headers: Record<string, string>) => boolean
}

export function readPath(body: unknown, path: string): unknown {
	let node: unknown = body
	for (const segment of path
		.replace(/^\$\.?/, "")
		.split(".")
		.filter(Boolean)) {
		if (node === null || typeof node !== "object") return undefined
		const index = Number.parseInt(segment, 10)
		node = Array.isArray(node)
			? Number.isNaN(index)
				? undefined
				: node[index]
			: (node as Record<string, unknown>)[segment]
	}
	return node
}

/** `{name}` placeholders resolved from the accumulated scope. */
function interpolate(value: unknown, scope: Record<string, string>): unknown {
	if (typeof value === "string") {
		return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => scope[key] ?? match)
	}
	if (Array.isArray(value)) return value.map((item) => interpolate(item, scope))
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = interpolate(item, scope)
		}
		return out
	}
	return value
}

/**
 * Decodes a JWT expiry without verifying the signature — oat is reading its own credential to
 * schedule a refresh, not making a trust decision about it.
 */
export function jwtClaims(credential: string): Record<string, unknown> | null {
	const parts = credential.split(".")
	if (parts.length !== 3 || parts[1] === undefined) return null
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
	} catch {
		return null
	}
}

export function jwtExpiryMs(credential: string): number | null {
	const claims = jwtClaims(credential)
	return typeof claims?.exp === "number" ? claims.exp * 1000 : null
}

export interface OriginClient {
	client: Client
	model: SpecModel
}

export interface AcquireContext {
	client: Client
	model: SpecModel
	hooks: Hooks
	principalId: string
	outOfBand?: Partial<BackoffConfig>
	originClients?: ReadonlyMap<string, OriginClient>
}

/** Runs an auth step list against an existing scope, returning the credential and bindings. */
export async function runAuthSteps(
	steps: readonly AuthStep[],
	spec: AcquireSpec,
	context: AcquireContext,
	initialScope: Record<string, string> = {},
): Promise<{ credential: string; scope: Record<string, string>; expiresAt: number | null }> {
	const scope: Record<string, string> = { ...initialScope }
	let last: Exchange | undefined

	for (const [index, step] of steps.entries()) {
		const stepBind = "bind" in step ? step.bind : undefined
		for (const [name, literal] of Object.entries(stepBind ?? {})) {
			scope[name] = String(interpolate(literal, scope))
		}

		if ("outOfBand" in step) {
			const address = String(interpolate(step.outOfBand.address, scope))
			const value = await resolveOutOfBandValue(context.hooks.resolveOutOfBand, address, step.outOfBand.kind, {
				label: `principal "${context.principalId}"`,
				...(context.outOfBand === undefined ? {} : { outOfBand: context.outOfBand }),
			})
			scope[step.outOfBand.as] = value
			continue
		}

		const request = await resolveRequest(step, context, scope, index)
		last = await request.client.request(request.method, request.path, {
			...(request.body === undefined ? {} : { body: request.body }),
			...(request.contentType === undefined ? {} : { contentType: request.contentType }),
			...(request.headers === undefined ? {} : { headers: request.headers }),
			...(request.query === undefined ? {} : { query: request.query }),
			/* Auth hops must not trigger refresh / 401-retry — that is how a refresh deadlocks. */
			skipAuthRefresh: true,
			...("operationId" in step ? { operationId: step.operationId } : {}),
		})

		const acceptable = ("expect" in step ? step.expect : undefined) ?? []
		const ok = acceptable.length > 0 ? acceptable.includes(last.status) : last.status < 300
		if (!ok) {
			throw new Error(
				`oat: principal "${context.principalId}" failed at auth step ${index + 1} ` +
					`(${request.method} ${request.path}): expected ` +
					`${acceptable.length > 0 ? acceptable.join("/") : "2xx"}, got ${last.status} — ` +
					`${JSON.stringify(last.responseBody).slice(0, 200)}`,
			)
		}

		const saveClaimsFrom = "saveClaimsFrom" in step ? step.saveClaimsFrom : undefined
		if (saveClaimsFrom !== undefined) {
			const token = readPath(last.responseBody, saveClaimsFrom.token)
			const claims = typeof token === "string" ? jwtClaims(token) : null
			if (claims === null) {
				throw new Error(
					`oat: auth step ${index + 1} for "${context.principalId}" expected a JWT at ` +
						`${saveClaimsFrom.token}, but it is absent or not decodable`,
				)
			}
			for (const [name, claimPath] of Object.entries(saveClaimsFrom.bind)) {
				const value = readPath(claims, claimPath)
				if (value === undefined || value === null) {
					throw new Error(
						`oat: auth step ${index + 1} binds ${name} to claim "${claimPath}", which the token ` +
							`does not carry. Available claims: ${Object.keys(claims).join(", ")}`,
					)
				}
				scope[name] = String(value)
			}
		}

		const saveAs = "saveAs" in step ? step.saveAs : undefined
		for (const [name, path] of Object.entries(saveAs ?? {})) {
			const value = readPath(last.responseBody, path)
			if (value === undefined || value === null) {
				throw new Error(
					`oat: auth step ${index + 1} for "${context.principalId}" declares saveAs.${name} = ` +
						`"${path}", which is not present in the response`,
				)
			}
			scope[name] = String(value)
		}
	}

	const credential = scope.credential ?? String(readPath(last?.responseBody, spec.credentialFrom) ?? "")
	if (credential === "" || credential === "undefined") {
		throw new Error(
			`oat: principal "${context.principalId}" completed its chain but ${spec.credentialFrom} ` +
				"did not yield a credential",
		)
	}

	return { credential, expiresAt: computeExpiry(spec, last, credential), scope }
}

/** Runs the acquire chain once, returning the credential and everything bound along the way. */
export async function runAcquireChain(
	spec: AcquireSpec,
	context: AcquireContext,
): Promise<{ credential: string; scope: Record<string, string>; expiresAt: number | null }> {
	return runAuthSteps(spec.steps, spec, context)
}

const REGISTER_LIKE = /register|sign[-_]?up/i

function stepLooksLikeRegister(step: AuthStep, model: SpecModel): boolean {
	if ("outOfBand" in step) return false
	if (isOperationStep(step)) {
		if (REGISTER_LIKE.test(step.operationId)) return true
		const op = model.byOperationId.get(step.operationId)
		if (op === undefined) return false
		return op.freshPrincipal || REGISTER_LIKE.test(op.path)
	}
	if (isRequestStep(step)) return REGISTER_LIKE.test(step.path)
	return false
}

/** First HTTP hop looks like signup — re-running `steps` would 409, not refresh. */
export function acquireLooksLikeRegister(spec: AcquireSpec, model: SpecModel): boolean {
	const firstHttp = spec.steps.find((step) => !("outOfBand" in step))
	return firstHttp !== undefined && stepLooksLikeRegister(firstHttp, model)
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
	const want = name.toLowerCase()
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === want) return value
	}
	return undefined
}

function computeExpiry(spec: AcquireSpec, last: Exchange | undefined, credential: string): number | null {
	/* Prefer what the API states, then what the credential itself carries, then the configured
	 * fallback. Guessing an expiry that is too long means requests start failing mid-run for
	 * reasons that look like backend defects. */
	if (spec.expiresInFrom !== undefined) {
		const seconds = readPath(last?.responseBody, spec.expiresInFrom)
		if (typeof seconds === "number") return Date.now() + seconds * 1000
	}
	const fromJwt = jwtExpiryMs(credential)
	if (fromJwt !== null) return fromJwt
	if (spec.assumeTtlMs !== undefined) return Date.now() + spec.assumeTtlMs
	return null
}

function isOperationStep(step: AuthStep): step is OperationStep {
	return "operationId" in step
}

function isRequestStep(step: AuthStep): step is RequestStep {
	return "method" in step && "path" in step
}

async function resolveRequest(
	step: AuthStep,
	context: AcquireContext,
	scope: Record<string, string>,
	index: number,
): Promise<{
	method: string
	path: string
	body?: unknown
	contentType?: string | null
	headers?: Record<string, string>
	query?: Record<string, string>
	client: Client
}> {
	const target = targetOf(step, context, index)
	/* Two shapes, distinguished structurally: name an operation from the document, or give a raw
	 * method and path for an endpoint the document does not describe. */
	if (isOperationStep(step)) {
		const op = target.model.byOperationId.get(step.operationId)
		if (op === undefined) {
			throw new Error(
				`oat: auth step ${index + 1} names operation "${step.operationId}", which is not in the ` + "document",
			)
		}
		const raw = target.model.rawOperations.get(step.operationId)
		const interpolated = step.body === undefined ? undefined : interpolate(step.body, scope)
		const encoded = await encodeAuthBody(step.operationId, raw, interpolated)
		return {
			client: target.client,
			method: op.method,
			path: String(interpolate(op.path, scope)),
			...encoded,
			...(step.headers === undefined ? {} : { headers: interpolate(step.headers, scope) as Record<string, string> }),
			...(step.query === undefined ? {} : { query: interpolate(step.query, scope) as Record<string, string> }),
		}
	}

	if (!isRequestStep(step)) {
		throw new Error(`oat: auth step ${index + 1} declares neither an operationId nor a method and path`)
	}
	return {
		client: target.client,
		method: step.method,
		path: String(interpolate(step.path, scope)),
		...(step.body === undefined ? {} : { body: interpolate(step.body, scope) }),
		...(step.headers === undefined ? {} : { headers: interpolate(step.headers, scope) as Record<string, string> }),
		...(step.query === undefined ? {} : { query: interpolate(step.query, scope) as Record<string, string> }),
	}
}

function stepOrigin(step: AuthStep): string | undefined {
	if ("outOfBand" in step) return undefined
	if ("origin" in step && typeof step.origin === "string" && step.origin !== "") return step.origin
	return undefined
}

function targetOf(step: AuthStep, context: AcquireContext, index: number): OriginClient {
	const origin = stepOrigin(step)
	if (origin === undefined) return { client: context.client, model: context.model }
	const named = context.originClients?.get(origin)
	if (named === undefined) {
		const known = [...(context.originClients?.keys() ?? [])].join(", ")
		throw new Error(
			`oat: auth step ${index + 1} names origin "${origin}", which is not in config.origins` +
				(known === "" ? "" : ` (known: ${known})`),
		)
	}
	return named
}

async function encodeAuthBody(
	operationId: string,
	raw: ReturnType<SpecModel["rawOperations"]["get"]>,
	body: unknown,
): Promise<{ body?: unknown; contentType?: string | null }> {
	if (body === undefined) return {}
	const content = raw === undefined ? null : requestContent(raw)
	if (content === null || body === null || typeof body !== "object" || Array.isArray(body)) {
		return { body }
	}
	const encoded = await encodeRequest({
		fields: body as Record<string, unknown>,
		index: 0,
		mediaType: content.mediaType,
		operationId,
		schema: content.schema,
		uploads: { seed: 1 },
		variant: "baseline",
		...(content.encoding === undefined ? {} : { encoding: content.encoding }),
	})
	return encoded.contentType === undefined
		? { body: encoded.body }
		: { body: encoded.body, contentType: encoded.contentType }
}

/**
 * Out-of-band values usually land in an eventually-consistent store, so the hook is polled with
 * backoff rather than called once. A single read that happens to race the write looks exactly
 * like a broken delivery mechanism.
 */
export async function resolveOutOfBandValue(
	hook: Hooks["resolveOutOfBand"],
	address: string,
	kind: string,
	options: { label: string; outOfBand?: Partial<BackoffConfig> },
): Promise<string> {
	if (hook === undefined) {
		throw new Error(
			`oat: ${options.label} needs a "${kind}" value delivered outside HTTP, ` +
				"but the config declares no resolveOutOfBand hook. oat cannot read your mail catcher, " +
				"KV store or webhook sink — supply a function that can.",
		)
	}
	const backoff = resolveBackoff(options.outOfBand)
	const value = await pollWithBackoff((attempt) => hook({ address, attempt, kind }), backoff, isAbsentValue)
	if (typeof value === "string" && value !== "") return value
	throw new Error(
		`oat: no "${kind}" value arrived for ${address} after ${backoff.attempts} attempts ` +
			`(~${worstCaseWaitMs(backoff)}ms worst-case wait). The delivery mechanism is ` +
			"either slow beyond the backoff window or not firing at all.",
	)
}

export async function resolvePrincipalAuthValue(
	hook: Hooks["resolvePrincipalAuth"],
	fromHook: string,
	options: { label: string; outOfBand?: Partial<BackoffConfig> },
): Promise<PrincipalAuthResult> {
	if (hook === undefined) {
		throw new Error(
			`oat: ${options.label} declares auth.fromHook "${fromHook}", but the config has no ` +
				"resolvePrincipalAuth hook. Harvest the credential yourself and return it from that hook.",
		)
	}
	const backoff = resolveBackoff(options.outOfBand)
	const value = await pollWithBackoff(
		(_) => hook(fromHook),
		backoff,
		(result) => {
			if (result === null) return true
			return result.credential === ""
		},
	)
	if (value === undefined || value === null || value.credential === "") {
		throw new Error(
			`oat: resolvePrincipalAuth("${fromHook}") returned no credential for ${options.label} ` +
				`after ${backoff.attempts} attempts (~${worstCaseWaitMs(backoff)}ms worst-case wait).`,
		)
	}
	return value
}

/** Wraps a chain in a credential that refreshes itself before it expires. */
export async function createPrincipal(
	id: string,
	spec: PrincipalAuth,
	context: AcquireContext,
): Promise<PrincipalRuntime> {
	if (isHookAuth(spec)) return createHookPrincipal(id, spec, context)
	return createFlowPrincipal(id, spec, context)
}

async function createHookPrincipal(id: string, spec: HookAuth, context: AcquireContext): Promise<PrincipalRuntime> {
	let credential = ""
	let scope: Record<string, string> = {}
	const issued = new Set<string>()
	const header = spec.header ?? "authorization"
	const template = spec.template ?? "Bearer {credential}"
	const bufferMs = spec.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS
	const ctx: AcquireContext = { ...context, principalId: id }
	const authValue = (token: string): string => template.replace("{credential}", token)

	const runtime: PrincipalRuntime = {
		address: null,
		expiresAt: null,
		headers: () => ({ [header]: authValue(credential) }),
		id,
		matches: (headers) => {
			const sent = headerOf(headers, header)
			return sent !== undefined && issued.has(sent)
		},
		reacquire: async () => undefined,
		refreshIfStale: async () => undefined,
		scope,
	}

	const apply = (result: PrincipalAuthResult): void => {
		credential = result.credential
		if (result.refreshToken !== undefined) scope = { ...scope, refreshToken: result.refreshToken }
		runtime.scope = scope
		runtime.expiresAt =
			typeof result.expiresIn === "number"
				? Date.now() + result.expiresIn * 1000
				: spec.assumeTtlMs !== undefined
					? Date.now() + spec.assumeTtlMs
					: jwtExpiryMs(credential)
		issued.add(authValue(credential))
	}

	const harvest = async (): Promise<void> => {
		apply(
			await resolvePrincipalAuthValue(ctx.hooks.resolvePrincipalAuth, spec.fromHook, {
				label: `principal "${id}"`,
				...(ctx.outOfBand === undefined ? {} : { outOfBand: ctx.outOfBand }),
			}),
		)
	}

	await harvest()

	let inflight: Promise<void> | null = null
	let refreshing = false

	runtime.refreshIfStale = async (force = false): Promise<void> => {
		if (refreshing) return
		if (!force) {
			if (runtime.expiresAt === null) return
			if (runtime.expiresAt - Date.now() > bufferMs) return
		}
		if (inflight !== null) return inflight
		refreshing = true
		const pending = harvest().finally(() => {
			refreshing = false
			if (inflight === pending) inflight = null
		})
		inflight = pending
		return pending
	}

	runtime.reacquire = harvest
	return runtime
}

async function createFlowPrincipal(id: string, spec: AuthFlow, context: AcquireContext): Promise<PrincipalRuntime> {
	let credential = ""
	let scope: Record<string, string> = {}
	const issued = new Set<string>()
	const header = spec.header ?? "authorization"
	const template = spec.template ?? "Bearer {credential}"
	const bufferMs = spec.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS
	const ctx: AcquireContext = { ...context, principalId: id }

	const authValue = (token: string): string => template.replace("{credential}", token)

	const runtime: PrincipalRuntime = {
		address: null,
		expiresAt: null,
		headers: () => ({ [header]: authValue(credential) }),
		id,
		matches: (headers) => {
			const sent = headerOf(headers, header)
			return sent !== undefined && issued.has(sent)
		},
		reacquire: async () => undefined,
		refreshIfStale: async () => undefined,
		scope,
	}

	const apply = (result: { credential: string; scope: Record<string, string>; expiresAt: number | null }): void => {
		credential = result.credential
		scope = result.scope
		runtime.expiresAt = result.expiresAt
		runtime.scope = result.scope
		runtime.address = result.scope.address ?? result.scope.email ?? runtime.address
		issued.add(authValue(credential))
	}

	apply(await runAuthSteps(spec.steps, spec, ctx))

	let inflight: Promise<void> | null = null
	let refreshing = false

	const doRefresh = async (): Promise<void> => {
		refreshing = true
		try {
			if (spec.refresh !== undefined) {
				apply(await runAuthSteps(spec.refresh.steps, spec, ctx, scope))
				return
			}
			if (acquireLooksLikeRegister(spec, ctx.model)) {
				throw new AuthRefreshRequiredError(id)
			}
			apply(await runAuthSteps(spec.steps, spec, ctx))
		} finally {
			refreshing = false
		}
	}

	runtime.refreshIfStale = async (force = false): Promise<void> => {
		/* Re-entrant from an in-flight refresh hop: do not start a second refresh. */
		if (refreshing) return
		if (!force) {
			/* Static-header / unknown expiry: never proactive. 401 still passes force=true. */
			if (runtime.expiresAt === null) return
			if (runtime.expiresAt - Date.now() > bufferMs) return
		}
		if (inflight !== null) return inflight
		const pending = doRefresh().finally(() => {
			if (inflight === pending) inflight = null
		})
		inflight = pending
		return pending
	}

	runtime.reacquire = async () => {
		apply(await runAuthSteps(spec.steps, spec, ctx))
	}

	return runtime
}
