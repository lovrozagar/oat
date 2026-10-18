/**
 * Credential acquisition and lifecycle.
 *
 * oat knows nothing about any login route. A principal declares a chain of steps; each step is
 * an operation from the spec (or a raw request), values flow forward by JSON path, and anything
 * delivered outside HTTP — verification tokens, OTPs, magic links — comes from a hook the caller
 * writes. That hook is the entire backend-coupling surface.
 */

import { readPath } from "../client/read-path.ts"
import { headerValue } from "./headers.ts"
import { AsyncLocalStorage } from "node:async_hooks"
import type { Hooks } from "../config/types/hooks.ts"
import type { AuthFlow, HookAuth, PrincipalAuth, PrincipalAuthResult } from "../config/types/principals.ts"
import type { AuthStep } from "../config/types/steps.ts"
import { isHookAuth } from "./auth-kind.ts"
import type { SpecModel } from "../spec/graph/types.ts"
import type { Redactor } from "../security/redact.ts"
import { type BackoffConfig, pollWithBackoff, resolveBackoff, worstCaseWaitMs } from "./poll.ts"
import { runSteps } from "./steps/engine.ts"
import { computeExpiry } from "./steps/expiry.ts"
import { jwtExpiryMs } from "./steps/jwt.ts"
import { isOperationStep, isRequestStep, type StepContext } from "./steps/request.ts"

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
	/** Live credential string — last issued, not a cleared snapshot. */
	credential: () => string
	/** Address this principal was provisioned under, for cascade teardown. */
	address: string | null
	/** Values bound during acquisition — roots discovered from the credential live here too. */
	scope: Record<string, string>
	/**
	 * Renew when `expiresAt - now <= refreshBufferMs`, or immediately when `force` is set (401).
	 * `expiresAt === null` never proactive-refreshes. Single-flight per principal.
	 */
	refreshIfStale: (force?: boolean) => Promise<void>
	expiresAt: number | null
	/** True when `headers` carry a credential this principal issued (current or previous). */
	matches: (headers: Record<string, string>) => boolean
	/**
	 * Swap in a credential a later response issued (an invite accept, for example).
	 * Scope stays. Expiry becomes the new token's JWT `exp`, or none when it has no `exp`.
	 * Previously issued values still match.
	 */
	adoptCredential: (token: string) => void
}

/** Runs an auth step list against an existing scope, returning the credential and bindings. */
export async function runAuthSteps(
	steps: readonly AuthStep[],
	spec: AcquireSpec,
	context: StepContext,
	initialScope: Record<string, string> = {},
): Promise<{ credential: string; scope: Record<string, string>; expiresAt: number | null }> {
	const { last, scope } = await runSteps(context, steps, {
		credentialHeaders: (bound) => flowCredentialHeaders(spec, bound),
		scope: initialScope,
	})
	const credential = scope.credential ?? String(readPath(last?.body, spec.credentialFrom) ?? "")
	if (credential === "" || credential === "undefined") {
		throw new Error(
			`oat: principal "${context.principalId}" completed its chain but ${spec.credentialFrom} ` +
				"did not yield a credential",
		)
	}

	return { credential, expiresAt: computeExpiry(spec, last?.body, credential), scope }
}

/** The principal whose refresh the current async context belongs to, if any. */
const REFRESHING = new AsyncLocalStorage<string>()

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

function flowCredentialHeaders(spec: AcquireSpec, scope: Record<string, string>): Record<string, string> {
	const credential = scope.credential
	if (credential === undefined || credential === "") return {}
	const header = spec.header ?? "authorization"
	const template = spec.template ?? "Bearer {credential}"
	return { [header]: template.replace("{credential}", credential) }
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
		() => hook(fromHook),
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
	context: StepContext,
): Promise<PrincipalRuntime> {
	if (isHookAuth(spec)) return createHookPrincipal(id, spec, context)
	return createFlowPrincipal(id, spec, context)
}

async function createHookPrincipal(id: string, spec: HookAuth, context: StepContext): Promise<PrincipalRuntime> {
	let credential = ""
	let scope: Record<string, string> = {}
	const issued = new Set<string>()
	const header = spec.header ?? "authorization"
	const template = spec.template ?? "Bearer {credential}"
	const bufferMs = spec.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS
	const ctx: StepContext = { ...context, principalId: id }
	const authValue = (token: string): string => template.replace("{credential}", token)

	const adoptCredential = (token: string): void => {
		if (token === "") return
		credential = token
		runtime.expiresAt = jwtExpiryMs(token)
		issued.add(authValue(credential))
		ctx.client.redactor.registerHeader(header)
		ctx.client.redactor.registerSecret(credential)
		ctx.client.redactor.registerSecret(authValue(credential))
	}

	const runtime: PrincipalRuntime = {
		address: null,
		adoptCredential,
		credential: () => credential,
		expiresAt: null,
		headers: () => ({ [header]: authValue(credential) }),
		id,
		matches: (headers) => {
			const sent = headerValue(headers, header)
			return sent !== undefined && issued.has(sent)
		},
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
		/* Known to the redactor the moment it exists, under every name it travels by. */
		ctx.client.redactor.registerHeader(header)
		ctx.client.redactor.registerSecret(credential)
		ctx.client.redactor.registerSecret(authValue(credential))
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

	runtime.refreshIfStale = async (force = false): Promise<void> => {
		/* Only the refresh's own requests skip it; everyone else waits for the new credential. */
		if (REFRESHING.getStore() === id) return
		if (inflight !== null) return inflight
		if (!force) {
			if (runtime.expiresAt === null) return
			if (runtime.expiresAt - Date.now() > bufferMs) return
		}
		const pending = REFRESHING.run(id, harvest).finally(() => {
			if (inflight === pending) inflight = null
		})
		inflight = pending
		return pending
	}

	return runtime
}

async function createFlowPrincipal(id: string, spec: AuthFlow, context: StepContext): Promise<PrincipalRuntime> {
	let credential = ""
	let scope: Record<string, string> = {}
	const issued = new Set<string>()
	const header = spec.header ?? "authorization"
	const template = spec.template ?? "Bearer {credential}"
	const bufferMs = spec.refreshBufferMs ?? DEFAULT_REFRESH_BUFFER_MS
	const ctx: StepContext = { ...context, principalId: id }

	const authValue = (token: string): string => template.replace("{credential}", token)

	const adoptCredential = (token: string): void => {
		if (token === "") return
		credential = token
		runtime.expiresAt = jwtExpiryMs(token)
		issued.add(authValue(credential))
		ctx.client.redactor.registerHeader(header)
		ctx.client.redactor.registerSecret(credential)
		ctx.client.redactor.registerSecret(authValue(credential))
	}

	const runtime: PrincipalRuntime = {
		address: null,
		adoptCredential,
		credential: () => credential,
		expiresAt: null,
		headers: () => ({ [header]: authValue(credential) }),
		id,
		matches: (headers) => {
			const sent = headerValue(headers, header)
			return sent !== undefined && issued.has(sent)
		},
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
		/* Known to the redactor the moment it exists, under every name it travels by. */
		ctx.client.redactor.registerHeader(header)
		ctx.client.redactor.registerSecret(credential)
		ctx.client.redactor.registerSecret(authValue(credential))
	}

	apply(await runAuthSteps(spec.steps, spec, ctx))

	let inflight: Promise<void> | null = null

	const doRefresh = async (): Promise<void> => {
		if (spec.refresh !== undefined) {
			/* The refresh response decides the new credential. The acquire's own saveAs binding
			 * is the old one, and carrying it in would keep the stale token forever. */
			const { credential: _stale, ...carried } = scope
			apply(await runAuthSteps(spec.refresh.steps, spec, ctx, carried))
			return
		}
		if (acquireLooksLikeRegister(spec, ctx.model)) {
			throw new AuthRefreshRequiredError(id)
		}
		apply(await runAuthSteps(spec.steps, spec, ctx))
	}

	runtime.refreshIfStale = async (force = false): Promise<void> => {
		/* Only the refresh's own requests skip it. Every other caller — including one that
		 * arrives while a refresh is running — waits for the new credential rather than going
		 * ahead with the old one. */
		if (REFRESHING.getStore() === id) return
		if (inflight !== null) return inflight
		if (!force) {
			/* Static-header / unknown expiry: never proactive. 401 still passes force=true. */
			if (runtime.expiresAt === null) return
			if (runtime.expiresAt - Date.now() > bufferMs) return
		}
		const pending = REFRESHING.run(id, doRefresh).finally(() => {
			if (inflight === pending) inflight = null
		})
		inflight = pending
		return pending
	}

	return runtime
}

/**
 * A principal's static headers, held for it. Copied so adopting a credential does not mutate the
 * config object; a `Bearer ` prefix is kept when that is how the header was already written.
 */
export function holdHeaders(
	initial: Record<string, string> | undefined,
	redactor: Redactor,
): { headers: () => Record<string, string>; adoptCredential: (token: string) => void } {
	let current: Record<string, string> = initial === undefined ? {} : { ...initial }
	return {
		adoptCredential: (token: string) => {
			if (token === "") return
			const key = Object.keys(current).find((name) => name.toLowerCase() === "authorization") ?? "authorization"
			const previous = current[key]
			const value = previous === undefined || /^bearer\s+/i.test(previous) ? `Bearer ${token}` : token
			current = { ...current, [key]: value }
			redactor.registerHeader(key)
			redactor.registerSecret(token)
			redactor.registerSecret(value)
		},
		headers: () => current,
	}
}

/**
 * The headers a token from a fresh principal's signup is sent in. Always a bearer `authorization`
 * header today, whatever the operation's security declares: phase 8 replaces this with the
 * placement the credential source resolves per operation.
 */
export function bearerHeaders(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` }
}
