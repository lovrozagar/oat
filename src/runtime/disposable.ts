/**
 * `x-destructive` runs as a second user, never the suite caller. That user signs up through the
 * suite principal's own auth flow with a fresh address, or through the document's
 * `x-fresh-principal` operation. Afterwards the suite caller's own read still answers 200. An
 * operation that invalidates the caller read must leave that second user's credential refused,
 * and a declared refresh must no longer renew it.
 *
 * What a destructive call needs beforehand — a second factor enabled, a credential registered,
 * ownership handed off — is product knowledge. When the call is refused for want of it, the
 * operation stays untested and a scenario sets the scene.
 */

import type { AuthFlow, Hooks, PrincipalAuth } from "../config/define-config.ts"
import { isHookAuth } from "../config/define-config.ts"
import { deriveCollectionShape, deriveIdentity, effective, successSchema } from "../spec/collection.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import { createPrincipal, readPath, runAuthSteps } from "./auth.ts"
import type { CheckId } from "./check-ids.ts"
import type { Check } from "./checks.ts"
import type { Client, Exchange } from "./client.ts"
import { ASSERTED, type FindingCollector, type Outcome } from "./finding.ts"
import { buildCohort, isOverflowError } from "./fixture.ts"
import { applyResolveInput } from "./input.ts"
import type { BackoffConfig } from "./poll.ts"
import type { GradeLedger, PassEvidence } from "./scope.ts"
import { fillPath, requestSchemaOf } from "./world.ts"

export const DISPOSABLE_CHECK_ID = "auth.destructive-spares-the-caller" as const satisfies CheckId

export const disposableCheck: Check = {
	id: DISPOSABLE_CHECK_ID,
	mutates: true,
	needs: "x-destructive, a way to sign up a second user, and a caller read",
	plan: () => ({ ok: false }),
	run: (): Promise<Outcome> => Promise.resolve(ASSERTED),
	/* Destructive routes have no entity. `runDisposableOps` grades them after the entity loop. */
	subjects: () => [],
}

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

/** The caller reading itself: an `identity: self` read with nothing to fill in. */
function callerRead(model: SpecModel): OperationModel | undefined {
	return model.operations.find((op) => op.identity === "self" && op.action === "read" && op.pathParams.length === 0)
}

function invalidatesCaller(op: OperationModel, read: OperationModel): boolean {
	return op.invalidates.some((route) => route === `${read.method.toUpperCase()} ${read.path}` || route === read.route)
}

function authFlowOf(auth: PrincipalAuth | undefined): AuthFlow | null {
	if (auth === undefined || isHookAuth(auth) || !("steps" in auth)) return null
	return auth
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

/** The suite principal's signup flow, sent for a different address. Nothing else changes. */
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

/** Top-level strings a signup answered with — tokens a later body may need by the same name. */
function answered(exchange: Exchange | undefined): Record<string, unknown> {
	const body = exchange?.responseBody
	if (body === null || typeof body !== "object" || Array.isArray(body)) return {}
	return Object.fromEntries(
		Object.entries(body as Record<string, unknown>).filter(([, value]) => typeof value === "string"),
	)
}

interface Session {
	headers: () => Record<string, string>
	/** Values the signup sent or returned, by name — a body field with the same name gets them. */
	known: Record<string, unknown>
	roots: Record<string, string>
	/** Re-runs the flow's declared refresh; resolves to the exchange it ended on, if any. */
	renew?: () => Promise<Exchange | undefined>
}

interface Input {
	auth: () => Record<string, string>
	client: Client
	findings: FindingCollector
	checksRun?: Set<string>
	grades: GradeLedger
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	nonce?: string
	authFlow?: PrincipalAuth
	hooks?: Hooks
	outOfBand?: Partial<BackoffConfig>
	resolveInput?: Hooks["resolveInput"]
	rootsFromFlow?: Record<string, string>
	seed?: number
	/** Kept for callers; the signup comes from the auth flow or `x-fresh-principal`. */
	registerOperationId?: string
}

async function signUp(input: Input, label: string): Promise<Session | null> {
	const flow = authFlowOf(input.authFlow)
	/* Only a flow that signs up an address can sign up a different one; a fixed login would just
	 * hand back the suite user. */
	if (flow !== null && input.hooks !== undefined && signupEmail(flow) !== undefined) {
		const email = disposableAddress(flow, `${input.nonce ?? "user"}-${label}`)
		const fresh = freshSignupFlow(flow, email)
		const context = {
			client: input.client,
			hooks: input.hooks,
			model: input.model,
			principalId: `disposable-${label}`,
			...(input.outOfBand === undefined ? {} : { outOfBand: input.outOfBand }),
		}
		const principal = await createPrincipal(`disposable-${label}`, fresh, context)
		if (principal.credential() === "") return null
		const signupId = signupOperationId(fresh)
		const signup = input.client.transcript.findLast(
			(exchange) => exchange.operationId === signupId && exchange.status >= 200 && exchange.status < 300,
		)
		const known: Record<string, unknown> = { ...answered(signup), ...principal.scope, email }
		for (const step of fresh.steps) {
			if ("body" in step && step.body !== null && typeof step.body === "object") {
				for (const [key, value] of Object.entries(step.body as Record<string, unknown>)) known[key] ??= value
			}
		}
		const roots: Record<string, string> = {}
		for (const [param, key] of Object.entries(input.rootsFromFlow ?? {})) {
			const value = principal.scope[key]
			if (value !== undefined) roots[param] = value
		}
		const refresh = fresh.refresh
		return {
			headers: principal.headers,
			known,
			roots,
			...(refresh === undefined
				? {}
				: {
						renew: async () => {
							const before = input.client.transcript.length
							try {
								await runAuthSteps(refresh.steps, fresh, context, { ...principal.scope })
							} catch {
								/* A refused refresh is what a revoked session should answer. */
							}
							return input.client.transcript.slice(before).at(-1)
						},
					}),
		}
	}
	const register = input.model.operations.find((op) => op.freshPrincipal)
	if (register === undefined) return null
	const schema = requestSchemaOf(register, input.model)
	let body: Record<string, unknown> = {}
	if (schema !== null) {
		const [member] = buildCohort(schema, input.seed ?? 1, ["baseline"], register.operationId, {
			nonce: `${input.nonce ?? "user"}${label}`,
		})
		body = member?.body ?? {}
		if (input.resolveInput !== undefined) {
			body = await applyResolveInput(body, register.operationId, schema, input.resolveInput)
		}
	}
	const signup = await input.client.request(register.method, register.path, {
		body,
		headers: {},
		operationId: register.operationId,
	})
	const token = readPath(signup.responseBody, "$.access_token")
	if (signup.status < 200 || signup.status >= 300 || typeof token !== "string" || token === "") return null
	return { headers: () => ({ authorization: `Bearer ${token}` }), known: { ...answered(signup), ...body }, roots: {} }
}

function recordsOf(body: unknown, op: OperationModel, model: SpecModel): Record<string, unknown>[] {
	const raw = model.rawOperations.get(op.operationId)
	const shape = raw === undefined ? null : deriveCollectionShape(successSchema(raw))
	if (body === null || typeof body !== "object") return []
	const value = shape?.key === null || shape?.key === undefined ? body : (body as Record<string, unknown>)[shape.key]
	if (!Array.isArray(value)) return []
	return value.filter(
		(item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
	)
}

function identityOf(list: OperationModel, model: SpecModel, param: string): string {
	const raw = model.rawOperations.get(list.operationId)
	const shape = raw === undefined ? null : deriveCollectionShape(successSchema(raw))
	const props = effective(shape?.itemSchema ?? null)?.properties
	if (props !== null && props !== undefined && typeof props === "object" && param in props) return param
	return deriveIdentity(shape?.itemSchema ?? null, param) ?? "id"
}

/** The collection read one level up — `GET /a/{id}` lists for `DELETE /a/{id}/b/{item}`. */
function parentList(model: SpecModel, op: OperationModel): OperationModel | undefined {
	const parent = op.path.replace(/\/\{[^}]+\}$/, "")
	return model.operations.find((item) => item.method.toUpperCase() === "GET" && item.path === parent)
}

function bodyFor(schema: Record<string, unknown> | null, known: Record<string, unknown>, generated: unknown): unknown {
	if (schema === null) return undefined
	const out = generated !== null && typeof generated === "object" ? { ...(generated as Record<string, unknown>) } : {}
	const props = schema.properties
	if (props !== null && props !== undefined && typeof props === "object") {
		for (const name of Object.keys(props)) if (name in known) out[name] = known[name]
	}
	return out
}

export async function runDisposableOps(input: Input): Promise<void> {
	const ops = destructiveOps(input.model).filter((op) => input.mode === "full" || input.inScope(op.operationId))
	if (ops.length === 0) return
	input.checksRun?.add(DISPOSABLE_CHECK_ID)
	const selfRead = callerRead(input.model)
	if (selfRead === undefined) {
		input.grades.skipped(
			ops.map((op) => op.operationId),
			"no caller read (an identity: self read)",
		)
		return
	}
	/* An operation that ends the session gets a user of its own, so no order between them matters. */
	let shared: Session | null | undefined
	for (const [index, op] of ops.entries()) {
		const ends = invalidatesCaller(op, selfRead)
		let session: Session | null
		try {
			session = ends ? await signUp(input, `${index}`) : (shared ??= await signUp(input, "shared"))
		} catch (error) {
			input.grades.skipped(
				[op.operationId],
				`the second user could not sign up: ${error instanceof Error ? error.message : String(error)}`,
			)
			continue
		}
		if (session === null) {
			input.grades.skipped([op.operationId], "no way to sign up a second user (an auth flow or x-fresh-principal)")
			continue
		}
		await runOne(op, session, selfRead, ends)
	}

	async function runOne(op: OperationModel, session: Session, read: OperationModel, ends: boolean): Promise<void> {
		const blame = input.findings.attributed([op.operationId]).ownedBy(DISPOSABLE_CHECK_ID)
		const entity = op.entity ?? read.entity ?? "caller"
		const values: Record<string, string> = { ...session.roots }
		for (const param of op.pathParams) {
			if (values[param] !== undefined) continue
			const list = parentList(input.model, op)
			if (list === undefined) {
				input.grades.skipped([op.operationId], `unresolved param ${param}`)
				return
			}
			const listed = await input.client.request(list.method, fillPath(list.path, values), {
				headers: session.headers,
				operationId: list.operationId,
			})
			const field = identityOf(list, input.model, param)
			const row = recordsOf(listed.responseBody, list, input.model).find((item) => typeof item[field] === "string")
			if (row === undefined) {
				input.grades.skipped([op.operationId], "the list returned no id")
				return
			}
			values[param] = String(row[field])
		}
		const schema = requestSchemaOf(op, input.model)
		let generated: unknown = {}
		if (schema !== null) {
			try {
				generated = buildCohort(schema, input.seed ?? 1, ["baseline"], op.operationId, {
					nonce: `${input.nonce ?? "user"}d`,
				})[0]?.body
			} catch (error) {
				if (!isOverflowError(error)) throw error
			}
			if (input.resolveInput !== undefined && generated !== null && typeof generated === "object") {
				generated = await applyResolveInput(
					generated as Record<string, unknown>,
					op.operationId,
					schema,
					input.resolveInput,
				)
			}
		}
		const body = bodyFor(schema, session.known, generated)
		const called = await input.client.request(op.method, fillPath(op.path, values), {
			...(body === undefined ? {} : { body }),
			headers: session.headers,
			operationId: op.operationId,
		})
		if (called.status >= 500) {
			input.grades.graded([op.operationId], DISPOSABLE_CHECK_ID)
			blame.backend(
				DISPOSABLE_CHECK_ID,
				entity,
				"the disposable call failed",
				`${op.operationId} returned ${called.status}.`,
				[called],
			)
			return
		}
		if (called.status < 200 || called.status >= 300) {
			input.grades.skipped(
				[op.operationId],
				`destructive call returned ${called.status}; a scenario must set the scene`,
			)
			return
		}
		input.grades.graded([op.operationId], DISPOSABLE_CHECK_ID)
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
			return
		}
		let observation: PassEvidence["observation"]
		const param = op.pathParams.at(-1)
		const list = parentList(input.model, op)
		if (op.method.toUpperCase() === "DELETE" && param !== undefined && list !== undefined) {
			const listed = await input.client.request(list.method, fillPath(list.path, values), {
				headers: session.headers,
				operationId: list.operationId,
			})
			const field = identityOf(list, input.model, param)
			const value = values[param] ?? ""
			if (listed.status >= 200 && listed.status < 300) {
				if (recordsOf(listed.responseBody, list, input.model).some((row) => row[field] === value)) {
					blame.backend(
						DISPOSABLE_CHECK_ID,
						entity,
						"the credential was still listed",
						`${op.operationId} returned ${called.status}, and the follow-up list still contained ${value}.`,
						[called, listed],
					)
					return
				}
				observation = { absent: true, path: "$", seq: listed.seq, value }
			}
		}
		if (ends) {
			const gone = await input.client.request(read.method, read.path, {
				headers: session.headers,
				operationId: read.operationId,
			})
			const renewed = session.renew === undefined ? undefined : await session.renew()
			const refused = gone.status === 401 || gone.status === 403 || gone.status === 404
			const renewRefused = renewed === undefined || (renewed.status >= 400 && renewed.status < 500)
			if (!refused && !renewRefused) {
				blame.backend(
					DISPOSABLE_CHECK_ID,
					entity,
					"the disposable session was still accepted",
					`${op.operationId} invalidates ${read.operationId}, and that read then returned ${gone.status} with the second user's credential.`,
					renewed === undefined ? [called, gone] : [called, gone, renewed],
				)
				return
			}
			if (refused && renewed !== undefined && !renewRefused) {
				blame.backend(
					DISPOSABLE_CHECK_ID,
					entity,
					"the refresh token still renews after the session ended",
					`${op.operationId} ended the session, and the declared refresh then returned ${renewed.status}.`,
					[called, gone, renewed],
				)
				return
			}
			observation = refused
				? { seq: gone.seq, status: gone.status }
				: { seq: (renewed as Exchange).seq, status: (renewed as Exchange).status }
		}
		input.grades.prove(
			op.operationId,
			observation === undefined ? { call: called.seq } : { call: called.seq, observation },
		)
	}
}
