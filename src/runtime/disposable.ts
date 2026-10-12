/**
 * `x-destructive` runs as a second user registered through the spec, never the suite caller.
 * Afterwards the suite caller's own read still returns 200. When the operation invalidates
 * that read, the disposable credential's next read is 401.
 */

import type { Check } from "./checks.ts"
import type { Client, Exchange } from "./client.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "./finding.ts"
import type { CheckId } from "./check-ids.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { GradeLedger } from "./scope.ts"
import { buildCohort, isOverflowError } from "./fixture.ts"
import { applyResolveInput } from "./input.ts"
import { fillPath, requestSchemaOf } from "./world.ts"
import type { AuthFlow, Hooks, PrincipalAuth } from "../config/define-config.ts"
import { isHookAuth } from "../config/define-config.ts"
import { createPrincipal } from "./auth.ts"
import type { BackoffConfig } from "./poll.ts"

export const DISPOSABLE_CHECK_ID = "auth.destructive-spares-the-caller" as const satisfies CheckId

const REGISTER_LIKE = /register|sign[-_]?up/i

export function destructiveOps(model: SpecModel): OperationModel[] {
	return model.operations.filter((op) => op.destructive)
}

export function signupOperationId(auth: PrincipalAuth | undefined): string | undefined {
	if (auth === undefined || !("steps" in auth)) return undefined
	for (const step of auth.steps) {
		if ("operationId" in step && typeof step.operationId === "string") return step.operationId
	}
	return undefined
}

function looksLikeSignup(op: OperationModel): boolean {
	if (/passkey/i.test(op.operationId) || /passkey/i.test(op.path)) return false
	return REGISTER_LIKE.test(op.operationId) || REGISTER_LIKE.test(op.path)
}

function registerOperation(model: SpecModel, preferredId?: string): OperationModel | undefined {
	const preferred = preferredId === undefined ? undefined : model.byOperationId.get(preferredId)
	if (preferred !== undefined && (preferred.freshPrincipal || looksLikeSignup(preferred))) return preferred
	return model.operations.find((op) => op.freshPrincipal || looksLikeSignup(op))
}

function callerRead(model: SpecModel): OperationModel | undefined {
	const reads = model.operations.filter(
		(op) => op.identity === "self" && op.action === "read" && op.pathParams.length === 0,
	)
	return (
		reads.find((op) => op.operationId === "auth.getProfile" || op.path === "/v1/auth/me" || op.path === "/v1/me") ??
		reads[0]
	)
}

function propertyNames(schema: Record<string, unknown>): Set<string> {
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return new Set()
	return new Set(Object.keys(properties as Record<string, unknown>))
}

function requiredSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const required = Array.isArray(schema.required)
		? schema.required.filter((name): name is string => typeof name === "string")
		: []
	if (required.length === 0) return schema
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return schema
	const source = properties as Record<string, unknown>
	const picked: Record<string, unknown> = {}
	for (const name of required) if (name in source) picked[name] = source[name]
	return { ...schema, properties: picked, required }
}

function tokenOf(body: unknown): string | null {
	if (body === null || typeof body !== "object") return null
	const token = (body as Record<string, unknown>).access_token
	return typeof token === "string" && token !== "" ? token : null
}

export async function runDisposableOps(input: {
	auth: () => Record<string, string>
	client: Client
	findings: FindingCollector
	checksRun?: Set<string>
	grades: GradeLedger
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	nonce?: string
	/** The suite principal's signup operation, when its auth flow names one. */
	registerOperationId?: string
	authFlow?: PrincipalAuth
	hooks?: Hooks
	outOfBand?: Partial<BackoffConfig>
	resolveInput?: Hooks["resolveInput"]
	rootsFromFlow?: Record<string, string>
	seed?: number
}): Promise<void> {
	const ops = destructiveOps(input.model).filter((op) => input.mode === "full" || input.inScope(op.operationId))
	if (ops.length === 0) return
	input.checksRun?.add(DISPOSABLE_CHECK_ID)
	const ids = ops.map((op) => op.operationId)
	const register = registerOperation(input.model, input.registerOperationId)
	const read = callerRead(input.model)
	if (register === undefined || read === undefined) {
		const reason = register === undefined ? "no register operation" : "no caller read"
		input.grades.skipped(ids, reason)
		return
	}
	const flow = authFlowOf(input.authFlow)
	const flowSignsUp =
		flow !== null &&
		flow.steps.some(
			(step) =>
				"operationId" in step && /register|sign[-_]?up/i.test(step.operationId) && !/passkey/i.test(step.operationId),
		)
	let headers: () => Record<string, string>
	let issued: Record<string, unknown>
	let signupExchange: Exchange | undefined
	let adopt = (_body: unknown): void => undefined
	if (flowSignsUp && flow !== null && input.hooks !== undefined) {
		let session: Awaited<ReturnType<typeof sessionFromFlow>>
		try {
			session = await sessionFromFlow(flow, input)
		} catch (error) {
			session = null
			input.findings
				.attributed(ids)
				.ownedBy(DISPOSABLE_CHECK_ID)
				.backend(
					DISPOSABLE_CHECK_ID,
					read.entity ?? "caller",
					"the disposable signup failed",
					error instanceof Error ? error.message : "the auth flow did not yield a credential.",
					[],
				)
			input.grades.graded(ids, DISPOSABLE_CHECK_ID)
			return
		}
		if (session === null) {
			input.findings
				.attributed(ids)
				.ownedBy(DISPOSABLE_CHECK_ID)
				.backend(
					DISPOSABLE_CHECK_ID,
					read.entity ?? "caller",
					"the disposable signup failed",
					"the auth flow did not yield a credential.",
					[],
				)
			input.grades.graded(ids, DISPOSABLE_CHECK_ID)
			return
		}
		headers = session.headers
		issued = session.known
		adopt = session.adopt
	} else {
		const acquired = await sessionFromRegister(register, input)
		if (acquired === null) return
		headers = acquired.headers
		issued = acquired.issued
		signupExchange = acquired.exchange
		adopt = acquired.adopt
	}
	const ordered = [...ops].sort((a, b) => destructiveRank(a, read.path) - destructiveRank(b, read.path))
	for (const op of ordered) {
		const blame = input.findings.attributed([op.operationId]).ownedBy(DISPOSABLE_CHECK_ID)
		await createOnSamePath(input, op, headers)
		let path = op.path
		try {
			path = fillPath(op.path, rootsFor(input.rootsFromFlow, issued))
		} catch {
			blame.unresolved(DISPOSABLE_CHECK_ID, op.entity ?? read.entity ?? "caller", `${op.operationId} needs a path id`)
			input.grades.graded([op.operationId], DISPOSABLE_CHECK_ID)
			continue
		}
		await reauthenticate(input.model, input.client, headers, issued)
		const sent = bodyFrom(requestSchemaOf(op, input.model), issued)
		const called = await input.client.request(op.method, path, {
			...(Object.keys(sent).length === 0 ? {} : { body: sent }),
			headers,
			operationId: op.operationId,
		})
		adopt(called.responseBody)
		if (called.status >= 200 && called.status < 300 && typeof sent.new_password === "string") {
			issued.password = sent.new_password
			issued.current_password = sent.new_password
		}
		if (called.status < 200 || called.status >= 300) {
			blame.backend(
				DISPOSABLE_CHECK_ID,
				op.entity ?? read.entity ?? "caller",
				"the disposable call failed",
				`${op.operationId} returned ${called.status} for the second user.`,
				signupExchange === undefined ? [called] : [signupExchange, called],
			)
			input.grades.graded([op.operationId], DISPOSABLE_CHECK_ID)
			continue
		}
		const caller = await input.client.request(read.method, read.path, {
			headers: input.auth,
			operationId: read.operationId,
		})
		if (caller.status !== 200) {
			blame.backend(
				DISPOSABLE_CHECK_ID,
				read.entity ?? "caller",
				"the suite caller was logged out",
				`${op.operationId} ran as the second user, and the suite ${read.operationId} then returned ${caller.status}.`,
				[called, caller],
			)
			input.grades.graded([op.operationId], DISPOSABLE_CHECK_ID)
			continue
		}
		const endsSession = /logout|deleteaccount|account\/delete/i.test(`${op.operationId} ${op.path}`)
		if (endsSession) {
			const gone = await input.client.request(read.method, read.path, {
				headers,
				operationId: read.operationId,
			})
			const refreshToken = typeof sent.refresh_token === "string" ? sent.refresh_token : undefined
			const renew = refreshToken === undefined ? undefined : renewOperation(input.model, op.operationId)
			let renewExchange: Exchange | undefined
			if (gone.status !== 401 && renew !== undefined && refreshToken !== undefined) {
				renewExchange = await input.client.request(renew.method, renew.path, {
					body: { refresh_token: refreshToken },
					headers: {},
					operationId: renew.operationId,
				})
			}
			const sessionGone =
				gone.status === 401 ||
				(renewExchange !== undefined && renewExchange.status >= 400 && renewExchange.status < 500)
			if (!sessionGone) {
				blame.backend(
					DISPOSABLE_CHECK_ID,
					op.entity ?? read.entity ?? "caller",
					"the disposable session was still accepted",
					`${op.operationId} invalidates ${read.operationId}, and that read then returned ${gone.status} with the second user's credential.`,
					renewExchange === undefined ? [called, gone] : [called, gone, renewExchange],
				)
			}
		}
		input.grades.graded([op.operationId], DISPOSABLE_CHECK_ID)
	}
}

function destructiveRank(op: OperationModel, _callerPath: string): number {
	const label = `${op.operationId} ${op.path}`
	/* Deleting the account has to see a live reauth window, so it runs after the other calls
	 * and before logout, which revokes that session. */
	if (/deleteaccount|account\/delete/i.test(label)) return 2
	if (/logout/i.test(label)) return 3
	return 0
}

function authFlowOf(auth: PrincipalAuth | undefined): AuthFlow | null {
	if (auth === undefined || isHookAuth(auth) || !("steps" in auth)) return null
	return auth
}

export function freshSignupFlow(spec: AuthFlow, email: string): AuthFlow {
	const from = signupEmail(spec)
	const copy = structuredClone(spec)
	if (from === undefined || from === email) return copy
	return rewriteEmail(copy, from, email) as AuthFlow
}

export function disposableAddress(spec: AuthFlow, nonce: string): string {
	const from = signupEmail(spec)
	const at = from?.lastIndexOf("@") ?? -1
	const domain = at > 0 && from !== undefined ? from.slice(at + 1) : "example.test"
	return `oat-disp-${nonce}@${domain}`
}

function signupEmail(spec: AuthFlow): string | undefined {
	for (const step of spec.steps) {
		if ("bind" in step && typeof step.bind?.address === "string") return step.bind.address
		if ("body" in step && step.body !== null && typeof step.body === "object" && "email" in step.body) {
			const email = (step.body as { email?: unknown }).email
			if (typeof email === "string") return email
		}
	}
	return undefined
}

function signupPassword(spec: AuthFlow): string | undefined {
	for (const step of spec.steps) {
		if ("body" in step && step.body !== null && typeof step.body === "object" && "password" in step.body) {
			const password = (step.body as { password?: unknown }).password
			if (typeof password === "string") return password
		}
	}
	return undefined
}

function rewriteEmail(value: unknown, from: string, to: string): unknown {
	if (typeof value === "string") return value.split(from).join(to)
	if (Array.isArray(value)) return value.map((item) => rewriteEmail(item, from, to))
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value)) out[key] = rewriteEmail(item, from, to)
		return out
	}
	return value
}

async function sessionFromFlow(
	flow: AuthFlow,
	input: {
		client: Client
		hooks?: Hooks
		model: SpecModel
		nonce?: string
		outOfBand?: Partial<BackoffConfig>
	},
): Promise<{
	adopt: (body: unknown) => void
	headers: () => Record<string, string>
	known: Record<string, unknown>
} | null> {
	if (input.hooks === undefined) return null
	const email = disposableAddress(flow, input.nonce ?? "user")
	const password = signupPassword(flow)
	const principal = await createPrincipal("disposable", freshSignupFlow(flow, email), {
		client: input.client,
		hooks: input.hooks,
		model: input.model,
		principalId: "disposable",
		...(input.outOfBand === undefined ? {} : { outOfBand: input.outOfBand }),
	})
	if (principal.credential() === "") return null
	const known: Record<string, unknown> = { email }
	if (password !== undefined) {
		known.password = password
		known.current_password = password
		known.new_password = `${password}2`
	}
	const refresh = principal.scope.refreshToken
	if (refresh !== undefined) known.refresh_token = refresh
	for (const [key, value] of Object.entries(principal.scope)) known[key] = value
	return {
		adopt(body: unknown) {
			if (body === null || typeof body !== "object") return
			const record = body as Record<string, unknown>
			if (typeof record.access_token === "string") principal.adoptCredential(record.access_token)
			if (typeof record.refresh_token === "string") known.refresh_token = record.refresh_token
		},
		headers: principal.headers,
		known,
	}
}

async function sessionFromRegister(
	register: OperationModel,
	input: {
		client: Client
		findings: FindingCollector
		grades: GradeLedger
		model: SpecModel
		nonce?: string
		resolveInput?: Hooks["resolveInput"]
		seed?: number
	},
): Promise<{
	adopt: (body: unknown) => void
	exchange: Exchange
	headers: () => Record<string, string>
	issued: Record<string, unknown>
} | null> {
	const ids = destructiveOps(input.model).map((op) => op.operationId)
	const read = callerRead(input.model)
	const schema = requestSchemaOf(register, input.model)
	let body: Record<string, unknown> = {}
	if (schema !== null) {
		try {
			const required = requiredSchema(schema)
			const [member] = buildCohort(required, input.seed ?? 1, ["baseline"], register.operationId, {
				distinct: propertyNames(required),
				...(input.nonce === undefined ? {} : { nonce: input.nonce }),
			})
			body = member?.body ?? {}
		} catch (error) {
			if (!isOverflowError(error)) throw error
			input.grades.skipped(ids, error instanceof Error ? error.message : "register body could not be generated")
			return null
		}
		if (input.resolveInput !== undefined) {
			body = await applyResolveInput(body, register.operationId, schema, input.resolveInput)
		}
	}
	const exchange = await input.client.request(register.method, register.path, {
		body,
		headers: {},
		operationId: register.operationId,
	})
	const token = tokenOf(exchange.responseBody)
	const issued =
		exchange.responseBody !== null && typeof exchange.responseBody === "object"
			? (exchange.responseBody as Record<string, unknown>)
			: {}
	if (exchange.status < 200 || exchange.status >= 300 || token === null) {
		input.findings
			.attributed(ids)
			.ownedBy(DISPOSABLE_CHECK_ID)
			.backend(
				DISPOSABLE_CHECK_ID,
				read?.entity ?? "caller",
				"the disposable signup failed",
				`${register.operationId} returned ${exchange.status}.`,
				[exchange],
			)
		input.grades.graded(ids, DISPOSABLE_CHECK_ID)
		return null
	}
	if (typeof body.password === "string") {
		issued.password = body.password
		issued.current_password = body.password
		issued.new_password = `${body.password}2`
	}
	const cred = { token }
	return {
		adopt(next: unknown) {
			if (next === null || typeof next !== "object") return
			const record = next as Record<string, unknown>
			if (typeof record.access_token === "string") {
				cred.token = record.access_token
				issued.access_token = record.access_token
			}
			if (typeof record.refresh_token === "string") issued.refresh_token = record.refresh_token
		},
		exchange,
		headers: () => ({ authorization: `Bearer ${cred.token}` }),
		issued,
	}
}

function rootsFor(map: Record<string, string> | undefined, known: Record<string, unknown>): Record<string, string> {
	const roots: Record<string, string> = {}
	for (const [param, key] of Object.entries(map ?? {})) {
		const value = known[key]
		if (typeof value === "string") roots[param] = value
	}
	return roots
}

async function reauthenticate(
	model: SpecModel,
	client: Client,
	headers: () => Record<string, string>,
	known: Record<string, unknown>,
): Promise<void> {
	const password = known.password
	if (typeof password !== "string") return
	const op = model.operations.find(
		(item) => /reauthentica|\/reauth/i.test(item.operationId) || /\/reauth/.test(item.path),
	)
	if (op === undefined) return
	await client.request(op.method, op.path, { body: { password }, headers, operationId: op.operationId })
}

async function createOnSamePath(
	input: { client: Client; model: SpecModel; nonce?: string; resolveInput?: Hooks["resolveInput"]; seed?: number },
	op: OperationModel,
	headers: () => Record<string, string>,
): Promise<void> {
	if (op.method !== "DELETE") return
	const create = input.model.operations.find(
		(item) => item.method === "POST" && item.path === op.path && item.operationId !== op.operationId,
	)
	if (create === undefined) return
	const schema = requestSchemaOf(create, input.model)
	let body: Record<string, unknown> = {}
	if (schema !== null) {
		try {
			const required = requiredSchema(schema)
			const [member] = buildCohort(required, input.seed ?? 1, ["baseline"], create.operationId, {
				distinct: propertyNames(required),
				...(input.nonce === undefined ? {} : { nonce: input.nonce }),
			})
			body = member?.body ?? {}
		} catch {
			return
		}
		if (input.resolveInput !== undefined)
			body = await applyResolveInput(body, create.operationId, schema, input.resolveInput)
	}
	await input.client.request(create.method, create.path, {
		...(Object.keys(body).length === 0 ? {} : { body }),
		headers,
		operationId: create.operationId,
	})
}

function renewOperation(model: SpecModel, exceptId: string): OperationModel | undefined {
	return model.operations.find((op) => {
		if (op.operationId === exceptId) return false
		const schema = requestSchemaOf(op, model)
		const properties = schema?.properties
		if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return false
		return "refresh_token" in (properties as Record<string, unknown>)
	})
}

function bodyFrom(schema: Record<string, unknown> | null, issued: Record<string, unknown>): Record<string, unknown> {
	if (schema === null) return {}
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return {}
	const body: Record<string, unknown> = {}
	for (const name of Object.keys(properties as Record<string, unknown>)) {
		const value = issued[name]
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") body[name] = value
	}
	return body
}

export const disposableCheck: Check = {
	id: DISPOSABLE_CHECK_ID,
	mutates: true,
	needs: "x-destructive, a register operation, and a caller read",
	plan: () => ({ ok: false }),
	run: (): Promise<Outcome> => Promise.resolve(ASSERTED),
	/* Destructive routes have no entity. `runDisposableOps` grades them after the entity loop. */
	subjects: () => [],
}
