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
import { deriveCollectionShape, effective, successSchema } from "../spec/collection.ts"
import type { SchemaObject } from "../spec/types.ts"
import type { GradeLedger } from "./scope.ts"
import { buildCohort, isOverflowError } from "./fixture.ts"
import { applyResolveInput } from "./input.ts"
import { fillPath, requestSchemaOf } from "./world.ts"
import type { AuthFlow, Hooks, PrincipalAuth } from "../config/define-config.ts"
import { isHookAuth } from "../config/define-config.ts"
import { createHmac } from "node:crypto"
import { createPrincipal, readPath, resolveOutOfBandValue } from "./auth.ts"
import { sleep, type BackoffConfig } from "./poll.ts"

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
	const suiteEmail = flow === null ? undefined : signupEmail(flow)
	const scene = createScene({
		adopt,
		client: input.client,
		headers,
		known: issued,
		model: input.model,
		nonce: input.nonce ?? "user",
		seed: input.seed ?? 1,
		suiteAuth: input.auth,
		...(input.hooks === undefined ? {} : { hooks: input.hooks }),
		...(input.outOfBand === undefined ? {} : { outOfBand: input.outOfBand }),
		...(input.resolveInput === undefined ? {} : { resolveInput: input.resolveInput }),
		...(suiteEmail === undefined ? {} : { suiteEmail }),
	})
	const ordered = [...ops].sort((a, b) => destructiveRank(a, input.model) - destructiveRank(b, input.model))
	for (const op of ordered) {
		const blame = input.findings.attributed([op.operationId]).ownedBy(DISPOSABLE_CHECK_ID)
		await createOnSamePath(input, op, headers)
		const values = await scene.pathValues(op, rootsFor(input.rootsFromFlow, issued))
		let path = op.path
		try {
			path = fillPath(op.path, values)
		} catch {
			blame.unresolved(DISPOSABLE_CHECK_ID, op.entity ?? read.entity ?? "caller", `${op.operationId} needs a path id`)
			input.grades.graded([op.operationId], DISPOSABLE_CHECK_ID)
			continue
		}
		await scene.reauthenticate()
		const sent = await scene.completeBody(op, bodyFrom(requestSchemaOf(op, input.model), issued))
		let called = await input.client.request(op.method, path, {
			...(Object.keys(sent).length === 0 ? {} : { body: sent }),
			headers,
			operationId: op.operationId,
		})
		let sameUser = true
		if (called.status < 200 || called.status >= 300) {
			const recovered = await scene.recover(op, called, values, sent)
			if (recovered !== null) {
				called = recovered.exchange
				path = recovered.path
				sameUser = recovered.sameUser
			}
		}
		if (sameUser) scene.note(called.responseBody, sent, called.status)
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

function destructiveRank(op: OperationModel, model: SpecModel): number {
	const label = `${op.operationId} ${op.path}`
	/* Deleting the account has to see a live reauth window, so it runs after the other calls
	 * and before logout, which revokes that session. */
	if (/deleteaccount|account\/delete/i.test(label)) return 80
	if (/logout/i.test(label)) return 90
	const request = propertyBag(requestSchemaOf(op, model))
	const required = requiredNames(requestSchemaOf(op, model))
	/* A password rotation revokes every session and wipes trusted devices. */
	if ("new_password" in request) return 70
	if (responseHas(op, model, "revoked_count")) return 70
	if (op.method === "DELETE" && op.pathParams.length === 0 && deviceCollection(op, model)) return 70
	/* Setting a password is for an account that does not have one yet, and it has to see the
	 * credential a rotation just issued when both calls are in the same run. */
	if (required.includes("password") && !("new_password" in request) && !("current_password" in request)) return 75
	if (op.method === "DELETE" && op.pathParams.length > 0 && deviceItem(op, model)) return 40
	if (responseHas(op, model, "secret", "otpauth_uri")) return 10
	if (required.includes("code") && responseHas(op, model, "enabled")) return 20
	if (required.includes("code")) return 30
	if (responseHas(op, model, "disabled")) return 50
	/* Leave a nested resource before the organization that contains it. Creating the membership
	 * needs the caller to still belong to that organization. */
	if (op.method === "POST" && op.path.endsWith("/leave")) {
		return op.pathParams.includes("organization_id") ? 65 : 55
	}
	return 60
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
	if (typeof body.email === "string" && typeof issued.email !== "string") issued.email = body.email
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

interface Scene {
	adopt: (body: unknown) => void
	client: Client
	headers: () => Record<string, string>
	hooks?: Hooks
	known: Record<string, unknown>
	model: SpecModel
	nonce: string
	outOfBand?: Partial<BackoffConfig>
	resolveInput?: Hooks["resolveInput"]
	seed: number
	suiteAuth: () => Record<string, string>
	suiteEmail?: string
}

interface SceneRuntime {
	completeBody: (op: OperationModel, body: Record<string, unknown>) => Promise<Record<string, unknown>>
	note: (body: unknown, sent: Record<string, unknown>, status: number) => void
	pathValues: (op: OperationModel, roots: Record<string, string>) => Promise<Record<string, string>>
	reauthenticate: () => Promise<void>
	recover: (
		op: OperationModel,
		failed: Exchange,
		values: Record<string, string>,
		sent: Record<string, unknown>,
	) => Promise<{ exchange: Exchange; path: string; sameUser: boolean } | null>
}

function createScene(scene: Scene): SceneRuntime {
	const backups: string[] = []
	const issuedCode = { last: "" }
	let stampedBearer: string | null = null
	const bearer = () => scene.headers().authorization ?? ""
	const nextCode = (): Promise<string | null> => harvestCode(scene, issuedCode)

	const note = (body: unknown, sent: Record<string, unknown>, status: number): void => {
		const before = bearer()
		scene.adopt(body)
		if (bearer() !== before) stampedBearer = null
		if (status < 200 || status >= 300) return
		if (typeof sent.new_password === "string") {
			scene.known.password = sent.new_password
			scene.known.current_password = sent.new_password
		}
		remember(body, scene.known, backups)
	}

	return {
		completeBody: (op, body) => completeBody(scene, op, body, nextCode),
		note,
		pathValues: (op, roots) => pathValues(scene, op, roots, backups, nextCode),
		reauthenticate: () => reauthenticate(scene, () => stampedBearer, (value) => { stampedBearer = value }, nextCode),
		recover: (op, failed, values, sent) => recover(scene, op, failed, values, sent),
	}
}

function remember(body: unknown, known: Record<string, unknown>, backups: string[]): void {
	if (body === null || typeof body !== "object") return
	const record = body as Record<string, unknown>
	if (typeof record.secret === "string" && typeof record.otpauth_uri === "string") {
		known.totp_secret = record.secret
		known.totp_uri = record.otpauth_uri
	}
	if (record.enabled === true) known.totp_on = true
	if (record.disabled === true) known.totp_on = false
	if (Array.isArray(record.backup_codes)) {
		const fresh = record.backup_codes.filter((code): code is string => typeof code === "string" && code !== "")
		if (fresh.length > 0) {
			backups.length = 0
			backups.push(...fresh)
		}
	}
}

async function reauthenticate(
	scene: Scene,
	stamped: () => string | null,
	stamp: (value: string | null) => void,
	nextCode: () => Promise<string | null>,
): Promise<void> {
	const password = scene.known.password
	if (typeof password !== "string") return
	const op = reauthOperation(scene.model)
	if (op === undefined) return
	const current = scene.headers().authorization ?? ""
	if (current !== "" && current === stamped()) return
	const request = propertyBag(requestSchemaOf(op, scene.model))
	const body: Record<string, unknown> = {}
	if ("password" in request) body.password = password
	if (scene.known.totp_on === true && "two_factor_code" in request) {
		const code = await nextCode()
		if (code !== null) body.two_factor_code = code
	}
	if (Object.keys(body).length === 0) return
	let called = await scene.client.request(op.method, op.path, { body, headers: scene.headers, operationId: op.operationId })
	if (called.status >= 400 && called.status < 500 && errorKey(called.responseBody).includes("two_factor") && !("two_factor_code" in body)) {
		const code = await nextCode()
		if (code !== null) {
			body.two_factor_code = code
			called = await scene.client.request(op.method, op.path, {
				body,
				headers: scene.headers,
				operationId: op.operationId,
			})
			scene.known.totp_on = true
		}
	}
	if (called.status >= 200 && called.status < 300) stamp(scene.headers().authorization ?? current)
}

function reauthOperation(model: SpecModel): OperationModel | undefined {
	return model.operations.find((item) => {
		if (!/\/reauth/.test(item.path) || /\/code/.test(item.path)) return false
		return "password" in propertyBag(requestSchemaOf(item, model))
	})
}

async function completeBody(
	scene: Scene,
	op: OperationModel,
	body: Record<string, unknown>,
	nextCode: () => Promise<string | null>,
): Promise<Record<string, unknown>> {
	const schema = requestSchemaOf(op, scene.model)
	const required = requiredNames(schema)
	if (required.includes("code") && body.code === undefined && typeof scene.known.totp_secret === "string") {
		const code = await nextCode()
		if (code !== null) body.code = code
	}
	if (required.includes("family_id") && body.family_id === undefined) {
		const family = await otherFamilyId(scene, nextCode)
		if (family !== null) body.family_id = family
	}
	return body
}

async function harvestFromSpec(scene: Scene, issuedCode: { last: string }): Promise<string | null> {
	const source = scene.model.operations.find((item) => {
		const props = propertyBag(requestSchemaOf(item, scene.model))
		return "secret" in props && "run_id" in props && responseHas(item, scene.model, "code")
	})
	const secret = scene.known.totp_secret
	if (source === undefined || typeof secret !== "string") return null
	for (let attempt = 0; attempt < 3; attempt++) {
		const runId = `oat-${scene.nonce}-${attempt}-${Date.now().toString(36)}`.slice(0, 64)
		const called = await scene.client.request(source.method, source.path, {
			body: { run_id: runId, secret },
			headers: scene.headers,
			operationId: source.operationId,
		})
		const code = stringField(called.responseBody, "code")
		if (code === null) return null
		if (code !== issuedCode.last) {
			issuedCode.last = code
			return code
		}
		await sleep(totpPeriodMs(scene.known))
	}
	return null
}

async function harvestCode(scene: Scene, issuedCode: { last: string }): Promise<string | null> {
	const fromSpec = await harvestFromSpec(scene, issuedCode)
	if (fromSpec !== null) return fromSpec
	const secret = scene.known.totp_secret
	if (typeof secret !== "string") return null
	const period = totpPeriodMs(scene.known)
	const digits = totpDigits(scene.known)
	for (let attempt = 0; attempt < 3; attempt++) {
		const code = totpCode(secret, Date.now(), period / 1000, digits)
		if (code !== "" && code !== issuedCode.last) {
			issuedCode.last = code
			return code
		}
		await sleep(period)
	}
	return null
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function base32Decode(input: string): Buffer {
	const clean = input.replace(/=+$/g, "").toUpperCase().replace(/[^A-Z2-7]/g, "")
	let bits = 0
	let value = 0
	const out: number[] = []
	for (const char of clean) {
		const index = BASE32.indexOf(char)
		if (index < 0) continue
		value = (value << 5) | index
		bits += 5
		if (bits >= 8) {
			bits -= 8
			out.push((value >>> bits) & 0xff)
		}
	}
	return Buffer.from(out)
}

/** RFC 6238 TOTP from a base32 secret. `atMs` 0 and the SHA-1 test secret yields `755224`. */
export function totpCode(secret: string, atMs: number, periodSeconds = 30, digits = 6): string {
	if (periodSeconds <= 0 || digits <= 0) return ""
	const counter = Math.floor(atMs / 1000 / periodSeconds)
	const key = base32Decode(secret)
	if (key.length === 0) return ""
	const message = Buffer.alloc(8)
	message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
	message.writeUInt32BE(counter >>> 0, 4)
	const hmac = createHmac("sha1", key).update(message).digest()
	const offset = (hmac.at(-1) ?? 0) & 0x0f
	const bin =
		((hmac[offset] ?? 0) & 0x7f) * 2 ** 24 +
		(hmac[offset + 1] ?? 0) * 2 ** 16 +
		(hmac[offset + 2] ?? 0) * 2 ** 8 +
		(hmac[offset + 3] ?? 0)
	return String(bin % 10 ** digits).padStart(digits, "0")
}

function totpDigits(known: Record<string, unknown>): number {
	const uri = known.totp_uri
	if (typeof uri !== "string") return 6
	try {
		const digits = Number(new URL(uri).searchParams.get("digits"))
		if (Number.isInteger(digits) && digits > 0) return digits
	} catch {
		/* The secret's own length is the fallback. */
	}
	return 6
}

function totpPeriodMs(known: Record<string, unknown>): number {
	const uri = known.totp_uri
	if (typeof uri !== "string") return 30_000
	try {
		const period = Number(new URL(uri).searchParams.get("period"))
		if (Number.isFinite(period) && period > 0) return period * 1000
	} catch {
		/* A secret without a parseable otpauth URI still steps on the common 30s window. */
	}
	return 30_000
}

async function otherFamilyId(scene: Scene, nextCode: () => Promise<string | null>): Promise<string | null> {
	const email = scene.known.email
	const password = scene.known.password
	if (typeof email !== "string" || typeof password !== "string") return null
	const login = scene.model.operations.find((item) => {
		if (looksLikeSignup(item)) return false
		const props = propertyBag(requestSchemaOf(item, scene.model))
		return "email" in props && "password" in props
	})
	if (login === undefined) return null
	const signed = await scene.client.request(login.method, login.path, {
		body: { email, password },
		headers: {},
		operationId: login.operationId,
	})
	await finishSecondFactor(scene, signed.responseBody, nextCode, false, [])
	const list = scene.model.operations.find((item) => item.method === "GET" && itemHas(item, scene.model, ["id", "current"]))
	if (list === undefined) return null
	let path = list.path
	try {
		path = fillPath(list.path, {})
	} catch {
		return null
	}
	const listed = await scene.client.request(list.method, path, { headers: scene.headers, operationId: list.operationId })
	const other = recordsOf(listed.responseBody, list, scene.model).find((row) => row.current === false)
	const id = other?.id
	return typeof id === "string" && id !== "" ? id : null
}

async function finishSecondFactor(
	scene: Scene,
	body: unknown,
	nextCode: () => Promise<string | null>,
	trust: boolean,
	backups: string[],
): Promise<void> {
	if (body === null || typeof body !== "object") return
	const record = body as Record<string, unknown>
	if (record.requires_2fa !== true || typeof record.temp_token !== "string") return
	const verify = scene.model.operations.find((item) => {
		const props = propertyBag(requestSchemaOf(item, scene.model))
		return "temp_token" in props && "code" in props
	})
	if (verify === undefined) return
	const props = propertyBag(requestSchemaOf(verify, scene.model))
	const sent: Record<string, unknown> = { temp_token: record.temp_token }
	if (trust && "trust_device" in props) sent.trust_device = true
	const backup = trust && "type" in props ? backups.shift() : undefined
	if (backup !== undefined) {
		sent.code = backup
		sent.type = enumValue(props.type, "backup") ?? "backup"
	} else {
		const code = await nextCode()
		if (code === null) return
		sent.code = code
		if ("type" in props) sent.type = enumValue(props.type, "totp") ?? "totp"
	}
	/* The second session must not replace the disposable credential. */
	await scene.client.request(verify.method, verify.path, { body: sent, headers: {}, operationId: verify.operationId })
}

async function pathValues(
	scene: Scene,
	op: OperationModel,
	roots: Record<string, string>,
	backups: string[],
	nextCode: () => Promise<string | null>,
): Promise<Record<string, string>> {
	const values = { ...roots }
	for (const param of op.pathParams) {
		if (values[param] !== undefined) continue
		const id = await discoverPathId(scene, op, backups, nextCode)
		if (id !== null) values[param] = id
	}
	return values
}

async function discoverPathId(
	scene: Scene,
	op: OperationModel,
	backups: string[],
	nextCode: () => Promise<string | null>,
): Promise<string | null> {
	const parent = op.path.replace(/\/\{[^}]+\}$/, "")
	const list = scene.model.operations.find((item) => item.method === "GET" && item.path === parent)
	if (list === undefined || !itemHas(list, scene.model, ["id"]) || itemHas(list, scene.model, ["current"])) return null
	const read = async (): Promise<string | null> => {
		let path = list.path
		try {
			path = fillPath(list.path, {})
		} catch {
			return null
		}
		const listed = await scene.client.request(list.method, path, { headers: scene.headers, operationId: list.operationId })
		const id = recordsOf(listed.responseBody, list, scene.model).find((row) => typeof row.id === "string")?.id
		return typeof id === "string" ? id : null
	}
	const existing = await read()
	if (existing !== null) return existing
	if (!itemHas(list, scene.model, ["expires_at"]) || scene.known.totp_on !== true) return null
	const email = scene.known.email
	const password = scene.known.password
	const login = scene.model.operations.find((item) => {
		if (looksLikeSignup(item)) return false
		const props = propertyBag(requestSchemaOf(item, scene.model))
		return "email" in props && "password" in props
	})
	if (login === undefined || typeof email !== "string" || typeof password !== "string") return null
	const signed = await scene.client.request(login.method, login.path, {
		body: { email, password },
		headers: {},
		operationId: login.operationId,
	})
	await finishSecondFactor(scene, signed.responseBody, nextCode, true, backups)
	return read()
}

async function recover(
	scene: Scene,
	op: OperationModel,
	failed: Exchange,
	values: Record<string, string>,
	sent: Record<string, unknown>,
): Promise<{ exchange: Exchange; path: string; sameUser: boolean } | null> {
	const key = errorKey(failed.responseBody)
	if (key === "password_already_exists") {
		const exchange = await callAsPasswordless(scene, op, sent)
		return exchange === null ? null : { exchange, path: failed.url, sameUser: false }
	}
	if (key.endsWith("last_owner")) {
		const handed = op.pathParams.length === 0 ? await releaseOwnedOrgs(scene) : await handOff(scene, op, values)
		if (!handed) return null
		const path = fillPath(op.path, values)
		const exchange = await scene.client.request(op.method, path, {
			...(Object.keys(sent).length === 0 ? {} : { body: sent }),
			headers: scene.headers,
			operationId: op.operationId,
		})
		return { exchange, path, sameUser: true }
	}
	if (key.endsWith("not_found") && op.pathParams.length > 0) {
		const created = await createOwnedId(scene, op, values)
		if (created === null) return null
		const next = { ...values, [created.param]: created.id }
		let path = fillPath(op.path, next)
		let exchange = await scene.client.request(op.method, path, {
			...(Object.keys(sent).length === 0 ? {} : { body: sent }),
			headers: scene.headers,
			operationId: op.operationId,
		})
		if (errorKey(exchange.responseBody).endsWith("last_owner")) {
			const handed = await handOff(scene, op, next)
			if (!handed) return { exchange, path, sameUser: true }
			path = fillPath(op.path, next)
			exchange = await scene.client.request(op.method, path, {
				...(Object.keys(sent).length === 0 ? {} : { body: sent }),
				headers: scene.headers,
				operationId: op.operationId,
			})
		}
		return { exchange, path, sameUser: true }
	}
	return null
}

async function callAsPasswordless(
	scene: Scene,
	op: OperationModel,
	sent: Record<string, unknown>,
): Promise<Exchange | null> {
	if (scene.hooks?.resolveOutOfBand === undefined) return null
	const start = scene.model.operations.find((item) => {
		const props = propertyBag(requestSchemaOf(item, scene.model))
		if (!("email" in props) || "password" in props) return false
		return tokenVerify(scene.model, item) !== undefined
	})
	const verify = start === undefined ? undefined : tokenVerify(scene.model, start)
	if (start === undefined || verify === undefined) return null
	const email = `oat-set-${scene.nonce}@${domainOf(scene.known.email)}`
	const opened = await scene.client.request(start.method, start.path, {
		body: { email },
		headers: {},
		operationId: start.operationId,
	})
	if (opened.status < 200 || opened.status >= 300) return null
	const token = await mailed(scene, email, mailKind(scene.model, start))
	if (token === null) return null
	const verified = await scene.client.request(verify.method, verify.path, {
		body: { token },
		headers: {},
		operationId: verify.operationId,
	})
	const access = stringField(verified.responseBody, "access_token")
	if (access === null) return null
	const headers = () => ({ authorization: `Bearer ${access}` })
	await reauthByMail(scene, headers, email)
	return scene.client.request(op.method, op.path, {
		...(Object.keys(sent).length === 0 ? {} : { body: sent }),
		headers,
		operationId: op.operationId,
	})
}

async function reauthByMail(scene: Scene, headers: () => Record<string, string>, email: string): Promise<void> {
	const requestCode = scene.model.operations.find((item) => item.path.endsWith("/reauth/code"))
	const reauth = reauthOperation(scene.model)
	if (requestCode === undefined || reauth === undefined || scene.hooks?.resolveOutOfBand === undefined) return
	const asked = await scene.client.request(requestCode.method, requestCode.path, {
		headers,
		operationId: requestCode.operationId,
	})
	if (asked.status < 200 || asked.status >= 300) return
	const code = await mailed(scene, email, mailKind(scene.model, requestCode))
	if (code === null) return
	const props = propertyBag(requestSchemaOf(reauth, scene.model))
	if (!("email_code" in props)) return
	await scene.client.request(reauth.method, reauth.path, {
		body: { email_code: code },
		headers,
		operationId: reauth.operationId,
	})
}

async function releaseOwnedOrgs(scene: Scene): Promise<boolean> {
	const leave = scene.model.operations.find(
		(item) => item.method === "POST" && item.path.endsWith("/leave") && item.pathParams.includes("organization_id"),
	)
	const list = collectionByParam(scene.model, "organization_id")
	if (leave === undefined || list === undefined) return false
	let path = list.path
	try {
		path = fillPath(list.path, {})
	} catch {
		return false
	}
	const listed = await scene.client.request(list.method, path, { headers: scene.headers, operationId: list.operationId })
	let handed = false
	for (const row of recordsOf(listed.responseBody, list, scene.model)) {
		if (typeof row.id !== "string") continue
		handed = (await handOff(scene, leave, { organization_id: row.id })) || handed
	}
	return handed
}

async function handOff(scene: Scene, op: OperationModel, values: Record<string, string>): Promise<boolean> {
	const email = scene.suiteEmail
	if (email === undefined || scene.hooks?.resolveOutOfBand === undefined) return false
	/* A project owner can hand the project to an organization member, not to a collaborator. */
	if (!op.pathParams.includes("organization_id") && values.organization_id !== undefined) {
		return handOffThroughOrg(scene, op, values)
	}
	const invite = scene.model.operations.find(
		(item) => item.invite !== null && item.pathParams.some((param) => op.pathParams.includes(param)),
	)
	if (invite?.invite === null || invite?.invite === undefined) return false
	let invitePath: string
	try {
		invitePath = fillPath(invite.path, values)
	} catch {
		return false
	}
	const inviteFields = propertyBag(requestSchemaOf(invite, scene.model))
	const grantee = invite.invite.granteeField
	const granteeField = grantee in inviteFields ? grantee : "email" in inviteFields ? "email" : grantee
	const invited = await scene.client.request(invite.method, invitePath, {
		body: { [granteeField]: email },
		headers: scene.headers,
		operationId: invite.operationId,
	})
	const duplicate = errorKey(invited.responseBody).includes("already")
	if ((invited.status < 200 || invited.status >= 300) && !duplicate) return false
	if (!duplicate) {
	const mailedToken =
		invite.invite.tokenFrom === "outOfBand"
			? await mailed(scene, email, invite.invite.tokenKind ?? mailKind(scene.model, invite))
			: null
	const pointed = readPath(invited.responseBody, invite.invite.tokenPointer)
	const token = mailedToken ?? (typeof pointed === "string" && pointed !== "" ? pointed : null)
	if (token === null) return false
	const accept = scene.model.byOperationId.get(invite.invite.accept)
	if (accept === undefined) return false
	let acceptPath: string
	try {
		acceptPath = fillPath(accept.path, values)
	} catch {
		return false
	}
	const accepted = await scene.client.request(accept.method, acceptPath, {
		body: { token },
		headers: scene.suiteAuth,
		operationId: accept.operationId,
	})
	if (accepted.status < 200 || accepted.status >= 300) return false
	}
	const members = scene.model.operations.find(
		(item) => item.method === "GET" && item.pathParams.some((param) => op.pathParams.includes(param)) && itemHas(item, scene.model, ["id", "invite_email"]),
	)
	if (members === undefined) return false
	let memberPath: string
	try {
		memberPath = fillPath(members.path, values)
	} catch {
		return false
	}
	const listed = await scene.client.request(members.method, memberPath, {
		headers: scene.headers,
		operationId: members.operationId,
	})
	const member = recordsOf(listed.responseBody, members, scene.model).find((row) => row.invite_email === email || row.email === email)
	const memberId = member?.id
	if (typeof memberId !== "string") return false
	const transfer = scene.model.operations.find((item) => {
		if (!requiredNames(requestSchemaOf(item, scene.model)).includes("member_id")) return false
		return item.pathParams.some((param) => op.pathParams.includes(param))
	})
	if (transfer === undefined) return false
	let transferPath: string
	try {
		transferPath = fillPath(transfer.path, values)
	} catch {
		return false
	}
	const moved = await scene.client.request(transfer.method, transferPath, {
		body: { member_id: memberId },
		headers: scene.headers,
		operationId: transfer.operationId,
	})
	return moved.status >= 200 && moved.status < 300
}

async function handOffThroughOrg(
	scene: Scene,
	op: OperationModel,
	values: Record<string, string>,
): Promise<boolean> {
	const email = scene.suiteEmail
	const organizationId = values.organization_id
	if (email === undefined || organizationId === undefined) return false
	const invite = scene.model.operations.find(
		(item) => item.invite !== null && item.pathParams.includes("organization_id"),
	)
	if (invite?.invite === null || invite?.invite === undefined) return false
	const orgValues = { organization_id: organizationId }
	let invitePath: string
	try {
		invitePath = fillPath(invite.path, orgValues)
	} catch {
		return false
	}
	const fields = propertyBag(requestSchemaOf(invite, scene.model))
	const grantee = invite.invite.granteeField
	const granteeField = grantee in fields ? grantee : "email" in fields ? "email" : grantee
	const invited = await scene.client.request(invite.method, invitePath, {
		body: { [granteeField]: email },
		headers: scene.headers,
		operationId: invite.operationId,
	})
	const duplicate = errorKey(invited.responseBody).includes("already")
	if ((invited.status < 200 || invited.status >= 300) && !duplicate) return false
	if (!duplicate) {
		const token = await mailed(scene, email, invite.invite.tokenKind ?? mailKind(scene.model, invite))
		if (token === null) return false
		const accept = scene.model.byOperationId.get(invite.invite.accept)
		if (accept === undefined) return false
		const accepted = await scene.client.request(accept.method, accept.path, {
			body: { token },
			headers: scene.suiteAuth,
			operationId: accept.operationId,
		})
		if (accepted.status < 200 || accepted.status >= 300) return false
	}
	const members = scene.model.operations.find(
		(item) =>
			item.method === "GET" &&
			item.pathParams.includes("organization_id") &&
			itemHas(item, scene.model, ["id", "user_id", "invite_email"]),
	)
	if (members === undefined) return false
	let memberPath: string
	try {
		memberPath = fillPath(members.path, orgValues)
	} catch {
		return false
	}
	const listed = await scene.client.request(members.method, memberPath, {
		headers: scene.headers,
		operationId: members.operationId,
	})
	const person = recordsOf(listed.responseBody, members, scene.model).find(
		(row) => row.invite_email === email || row.email === email,
	)
	const userId = person?.user_id
	if (typeof userId !== "string") return false
	const add = scene.model.operations.find((item) => {
		if (item.method !== "POST") return false
		if (!item.pathParams.some((param) => op.pathParams.includes(param))) return false
		return requiredNames(requestSchemaOf(item, scene.model)).includes("user_id")
	})
	if (add === undefined) return false
	let addPath: string
	try {
		addPath = fillPath(add.path, values)
	} catch {
		return false
	}
	const schema = requestSchemaOf(add, scene.model)
	const permissions = permissionList(schema)
	const added = await scene.client.request(add.method, addPath, {
		body: permissions === undefined ? { user_id: userId } : { permissions, user_id: userId },
		headers: scene.headers,
		operationId: add.operationId,
	})
	const createdId = stringField(added.responseBody, "id")
	const already = errorKey(added.responseBody).includes("already")
	if ((added.status < 200 || added.status >= 300) && !already) return false
	const memberId = createdId ?? (await projectMemberId(scene, op, values, userId))
	if (memberId === null) return false
	const transfer = scene.model.operations.find((item) => {
		if (!requiredNames(requestSchemaOf(item, scene.model)).includes("member_id")) return false
		return item.pathParams.some((param) => op.pathParams.includes(param))
	})
	if (transfer === undefined) return false
	let transferPath: string
	try {
		transferPath = fillPath(transfer.path, values)
	} catch {
		return false
	}
	const moved = await scene.client.request(transfer.method, transferPath, {
		body: { member_id: memberId },
		headers: scene.headers,
		operationId: transfer.operationId,
	})
	return moved.status >= 200 && moved.status < 300
}

async function projectMemberId(
	scene: Scene,
	op: OperationModel,
	values: Record<string, string>,
	userId: string,
): Promise<string | null> {
	const list = scene.model.operations.find(
		(item) =>
			item.method === "GET" &&
			item.pathParams.some((param) => op.pathParams.includes(param)) &&
			itemHas(item, scene.model, ["id", "user_id"]),
	)
	if (list === undefined) return null
	let path: string
	try {
		path = fillPath(list.path, values)
	} catch {
		return null
	}
	const listed = await scene.client.request(list.method, path, { headers: scene.headers, operationId: list.operationId })
	const rows = recordsOf(listed.responseBody, list, scene.model).filter((row) => row.user_id === userId)
	const direct = rows.find((row) => row.collaborator !== true) ?? rows[0]
	return typeof direct?.id === "string" ? direct.id : null
}

function permissionList(schema: Record<string, unknown> | null): string[] | undefined {
	const prop = propertyBag(schema).permissions
	if (prop === null || typeof prop !== "object") return undefined
	const items = (prop as { items?: unknown }).items
	if (items === null || typeof items !== "object") return undefined
	const values = (items as { enum?: unknown }).enum
	if (!Array.isArray(values)) return undefined
	const first = values.find((item): item is string => typeof item === "string")
	return first === undefined ? undefined : [first]
}

async function createOwnedId(
	scene: Scene,
	op: OperationModel,
	values: Record<string, string>,
): Promise<{ id: string; param: string } | null> {
	const param = op.pathParams.find((name) => name.endsWith("_id"))
	if (param === undefined) return null
	const resource = param.slice(0, -"_id".length)
	const plural = resource.endsWith("s") ? resource : `${resource}s`
	const create = scene.model.operations.find((item) => {
		if (item.method !== "POST" || item.operationId === op.operationId) return false
		if (item.path.split("/").filter(Boolean).at(-1) !== plural) return false
		return responseHas(item, scene.model, "id")
	})
	if (create === undefined) return null
	let path: string
	try {
		path = fillPath(create.path, values)
	} catch {
		return null
	}
	const body = await generatedBody(scene, create)
	const created = await scene.client.request(create.method, path, {
		...(Object.keys(body).length === 0 ? {} : { body }),
		headers: scene.headers,
		operationId: create.operationId,
	})
	const id = stringField(created.responseBody, "id")
	return id === null ? null : { id, param }
}

async function generatedBody(scene: Scene, op: OperationModel): Promise<Record<string, unknown>> {
	const schema = requestSchemaOf(op, scene.model)
	if (schema === null) return {}
	try {
		const required = requiredSchema(schema)
		const [member] = buildCohort(required, scene.seed, ["baseline"], op.operationId, {
			distinct: propertyNames(required),
			nonce: scene.nonce,
		})
		let body = member?.body ?? {}
		if (scene.resolveInput !== undefined) body = await applyResolveInput(body, op.operationId, schema, scene.resolveInput)
		return body
	} catch {
		return {}
	}
}

async function mailed(scene: Scene, address: string, kind: string): Promise<string | null> {
	if (scene.hooks?.resolveOutOfBand === undefined) return null
	try {
		return await resolveOutOfBandValue(scene.hooks.resolveOutOfBand, address, kind, {
			label: kind,
			...(scene.outOfBand === undefined ? {} : { outOfBand: scene.outOfBand }),
		})
	} catch {
		return null
	}
}

function tokenVerify(model: SpecModel, start: OperationModel): OperationModel | undefined {
	return model.operations.find((item) => {
		if (item.operationId === start.operationId || !item.path.startsWith(start.path)) return false
		if (!("token" in propertyBag(requestSchemaOf(item, model)))) return false
		return responseHas(item, model, "access_token")
	})
}

function mailKind(model: SpecModel, op: OperationModel): string {
	const kinds = mailboxKinds(model)
	const segments = op.path.split("/").filter(Boolean)
	const exact = kinds.find((kind) => segments.includes(kind))
	if (exact !== undefined) return exact
	const fuzzy = kinds.find((kind) => segments.some((segment) => segment.length >= 4 && kind.includes(segment)))
	if (fuzzy !== undefined) return fuzzy
	const summary = model.rawOperations.get(op.operationId)?.summary
	if (typeof summary === "string") {
		const named = summary.toLowerCase().match(/[a-z]+ code/)
		if (named !== null) return named[0].replace(" ", "-")
	}
	return segments.at(-1) ?? "mail"
}

function mailboxKinds(model: SpecModel): string[] {
	for (const op of model.operations) {
		if (op.method !== "GET") continue
		const params = model.rawOperations.get(op.operationId)?.parameters
		if (!Array.isArray(params)) continue
		for (const param of params) {
			if (param === null || typeof param !== "object") continue
			const record = param as Record<string, unknown>
			if (record.in !== "query" || record.name !== "type") continue
			const schema = record.schema
			if (schema === null || typeof schema !== "object") continue
			const values = (schema as { enum?: unknown }).enum
			if (!Array.isArray(values)) continue
			const kinds = values.filter((item): item is string => typeof item === "string")
			if (kinds.length > 0) return kinds
		}
	}
	return []
}

function collectionByParam(model: SpecModel, param: string): OperationModel | undefined {
	const resource = param.endsWith("_id") ? param.slice(0, -"_id".length) : param
	const plural = resource.endsWith("s") ? resource : `${resource}s`
	return model.operations.find((item) => {
		if (item.method !== "GET") return false
		if (item.path.split("/").filter(Boolean).at(-1) !== plural) return false
		return itemHas(item, model, ["id"])
	})
}

function deviceCollection(op: OperationModel, model: SpecModel): boolean {
	const list = model.operations.find((item) => item.method === "GET" && item.path === op.path)
	return list !== undefined && itemHas(list, model, ["id", "expires_at"]) && !itemHas(list, model, ["current"])
}

function deviceItem(op: OperationModel, model: SpecModel): boolean {
	const parent = op.path.replace(/\/\{[^}]+\}$/, "")
	const list = model.operations.find((item) => item.method === "GET" && item.path === parent)
	return list !== undefined && itemHas(list, model, ["id", "expires_at"]) && !itemHas(list, model, ["current"])
}

function itemHas(op: OperationModel, model: SpecModel, names: string[]): boolean {
	const props = itemProperties(op, model)
	return names.every((name) => name in props)
}

function itemProperties(op: OperationModel, model: SpecModel): Record<string, unknown> {
	const raw = model.rawOperations.get(op.operationId)
	const shape = raw === undefined ? null : deriveCollectionShape(successSchema(raw))
	const props = shape?.itemSchema?.properties
	if (props === null || typeof props !== "object" || Array.isArray(props)) return {}
	return props as Record<string, unknown>
}

function recordsOf(body: unknown, op: OperationModel, model: SpecModel): Record<string, unknown>[] {
	const raw = model.rawOperations.get(op.operationId)
	const shape = raw === undefined ? null : deriveCollectionShape(successSchema(raw))
	if (body === null || typeof body !== "object") return []
	const record = body as Record<string, unknown>
	const value = shape?.key === null || shape?.key === undefined ? body : record[shape.key]
	if (!Array.isArray(value)) return []
	return value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
}

function responseHas(op: OperationModel, model: SpecModel, ...names: string[]): boolean {
	const raw = model.rawOperations.get(op.operationId)
	const schema = raw === undefined ? null : effective(successSchema(raw))
	const props = propertyBag(schema as Record<string, unknown> | null)
	return names.every((name) => name in props)
}

function propertyBag(schema: Record<string, unknown> | null, depth = 0): Record<string, unknown> {
	if (schema === null || depth > 6) return {}
	const out: Record<string, unknown> = {}
	const flat = effective(schema as SchemaObject)
	const properties = flat?.properties
	if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
		Object.assign(out, properties)
	}
	for (const key of ["oneOf", "anyOf", "allOf"] as const) {
		const list = schema[key]
		if (!Array.isArray(list)) continue
		for (const item of list) {
			if (item !== null && typeof item === "object" && !Array.isArray(item)) {
				Object.assign(out, propertyBag(item as Record<string, unknown>, depth + 1))
			}
		}
	}
	return out
}

function requiredNames(schema: Record<string, unknown> | null): string[] {
	if (schema === null) return []
	const names = new Set<string>()
	const collect = (node: Record<string, unknown>, depth: number): void => {
		if (depth > 6) return
		if (Array.isArray(node.required)) {
			for (const name of node.required) if (typeof name === "string") names.add(name)
		}
		for (const key of ["oneOf", "anyOf", "allOf"] as const) {
			const list = node[key]
			if (!Array.isArray(list)) continue
			for (const item of list) {
				if (item !== null && typeof item === "object" && !Array.isArray(item)) collect(item as Record<string, unknown>, depth + 1)
			}
		}
	}
	collect(schema, 0)
	return [...names]
}

function enumValue(schema: unknown, prefer: string): string | undefined {
	if (schema === null || typeof schema !== "object") return undefined
	const values = (schema as { enum?: unknown }).enum
	if (!Array.isArray(values)) return prefer
	const strings = values.filter((item): item is string => typeof item === "string")
	if (strings.includes(prefer)) return prefer
	return strings[0]
}

function errorKey(body: unknown): string {
	return stringField(body, "error_key") ?? ""
}

function stringField(body: unknown, key: string): string | null {
	if (body === null || typeof body !== "object") return null
	const value = (body as Record<string, unknown>)[key]
	return typeof value === "string" && value !== "" ? value : null
}

function domainOf(email: unknown): string {
	if (typeof email !== "string") return "example.test"
	const at = email.lastIndexOf("@")
	return at > 0 ? email.slice(at + 1) : "example.test"
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
