/**
 * Credential acquisition and lifecycle.
 *
 * oat knows nothing about any login route. A principal declares a chain of steps; each step is
 * an operation from the spec (or a raw request), values flow forward by JSON path, and anything
 * delivered outside HTTP — verification tokens, OTPs, magic links — comes from a hook the caller
 * writes. That hook is the entire backend-coupling surface.
 */

import type { AuthFlow, AuthStep, Hooks, OperationStep, RequestStep } from "../config/define-config.ts"
import { requestContent } from "../spec/collection.ts"
import type { SpecModel } from "../spec/graph.ts"
import { encodeRequest } from "./body.ts"
import type { Client, Exchange } from "./client.ts"

/* The flow shape is defined once, in the public config — the runtime consumes it rather than
 * declaring a parallel copy that can drift out of agreement with what users actually write. */
export type AcquireSpec = AuthFlow

export interface PrincipalRuntime {
	id: string
	headers: () => Record<string, string>
	/** Address this principal was provisioned under, for cascade teardown. */
	address: string | null
	/** Values bound during acquisition — roots discovered from the credential live here too. */
	scope: Record<string, string>
	refreshIfStale: () => Promise<void>
	/** Forces reacquisition, used when a control probe proves the credential died early. */
	reacquire: () => Promise<void>
	expiresAt: number | null
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

export interface AcquireContext {
	client: Client
	model: SpecModel
	hooks: Hooks
	principalId: string
}

/** Runs the chain once, returning the credential and everything bound along the way. */
export async function runAcquireChain(
	spec: AcquireSpec,
	context: AcquireContext,
): Promise<{ credential: string; scope: Record<string, string>; expiresAt: number | null }> {
	const scope: Record<string, string> = {}
	let last: Exchange | undefined

	for (const [index, step] of spec.steps.entries()) {
		const stepBind = "bind" in step ? step.bind : undefined
		for (const [name, literal] of Object.entries(stepBind ?? {})) {
			scope[name] = String(interpolate(literal, scope))
		}

		if ("outOfBand" in step) {
			const address = String(interpolate(step.outOfBand.address, scope))
			const value = await resolveOutOfBand(context, address, step.outOfBand.kind)
			scope[step.outOfBand.as] = value
			continue
		}

		const request = await resolveRequest(step, context, scope, index)
		last = await context.client.request(request.method, request.path, {
			...(request.body === undefined ? {} : { body: request.body }),
			...(request.contentType === undefined ? {} : { contentType: request.contentType }),
			...(request.headers === undefined ? {} : { headers: request.headers }),
			...(request.query === undefined ? {} : { query: request.query }),
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
}> {
	/* Two shapes, distinguished structurally: name an operation from the document, or give a raw
	 * method and path for an endpoint the document does not describe. */
	if (isOperationStep(step)) {
		const op = context.model.byOperationId.get(step.operationId)
		if (op === undefined) {
			throw new Error(
				`oat: auth step ${index + 1} names operation "${step.operationId}", which is not in the ` + "document",
			)
		}
		const raw = context.model.rawOperations.get(step.operationId)
		const interpolated = step.body === undefined ? undefined : interpolate(step.body, scope)
		const encoded = await encodeAuthBody(step.operationId, raw, interpolated)
		return {
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
		method: step.method,
		path: String(interpolate(step.path, scope)),
		...(step.body === undefined ? {} : { body: interpolate(step.body, scope) }),
		...(step.headers === undefined ? {} : { headers: interpolate(step.headers, scope) as Record<string, string> }),
		...(step.query === undefined ? {} : { query: interpolate(step.query, scope) as Record<string, string> }),
	}
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
async function resolveOutOfBand(context: AcquireContext, address: string, kind: string): Promise<string> {
	const hook = context.hooks.resolveOutOfBand
	if (hook === undefined) {
		throw new Error(
			`oat: principal "${context.principalId}" needs a "${kind}" value delivered outside HTTP, ` +
				"but the config declares no resolveOutOfBand hook. oat cannot read your mail catcher, " +
				"KV store or webhook sink — supply a function that can.",
		)
	}
	let delay = 200
	for (let attempt = 1; attempt <= 6; attempt++) {
		const value = await hook({ address, attempt, kind })
		if (value !== null && value !== "") return value
		await new Promise((done) => setTimeout(done, delay))
		delay = Math.min(delay * 2, 3000)
	}
	throw new Error(
		`oat: no "${kind}" value arrived for ${address} after 6 attempts. The delivery mechanism is ` +
			"either slow beyond the backoff window or not firing at all.",
	)
}

/** Wraps a chain in a credential that refreshes itself before it expires. */
export async function createPrincipal(
	id: string,
	spec: AcquireSpec,
	context: AcquireContext,
): Promise<PrincipalRuntime> {
	let credential = ""
	let expiresAt: number | null = null
	let scope: Record<string, string> = {}

	const acquire = async (): Promise<void> => {
		const result = await runAcquireChain(spec, { ...context, principalId: id })
		credential = result.credential
		expiresAt = result.expiresAt
		scope = result.scope
	}

	await acquire()

	const header = spec.header ?? "authorization"
	const template = spec.template ?? "Bearer {credential}"

	const runtime: PrincipalRuntime = {
		/* Whatever the flow bound as an address is what teardown will cascade on. */
		address: scope.address ?? scope.email ?? null,
		expiresAt,
		headers: () => ({ [header]: template.replace("{credential}", credential) }),
		id,
		reacquire: acquire,
		/* Refresh at three quarters of the lifetime, before dispatch rather than mid-flight, so a
		 * run stays reproducible and no request is ever retried for timing reasons alone. */
		refreshIfStale: async () => {
			if (expiresAt === null) return
			const issuedWindow = expiresAt - Date.now()
			if (issuedWindow > 0 && issuedWindow < 0.25 * (spec.assumeTtlMs ?? 300_000)) await acquire()
			else if (issuedWindow <= 0) await acquire()
		},
		scope,
	}
	return runtime
}
