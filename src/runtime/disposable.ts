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
import { requestSchemaOf } from "./world.ts"
import type { Hooks, PrincipalAuth } from "../config/define-config.ts"

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
	resolveInput?: Hooks["resolveInput"]
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
	const schema = requestSchemaOf(register, input.model)
	let body: Record<string, unknown> = {}
	if (schema !== null) {
		try {
			const required = requiredSchema(schema)
			const distinct = propertyNames(required)
			const [member] = buildCohort(required, input.seed ?? 1, ["baseline"], register.operationId, {
				distinct,
				...(input.nonce === undefined ? {} : { nonce: input.nonce }),
			})
			body = member?.body ?? {}
		} catch (error) {
			if (!isOverflowError(error)) throw error
			input.grades.skipped(ids, error instanceof Error ? error.message : "register body could not be generated")
			return
		}
		if (input.resolveInput !== undefined) {
			body = await applyResolveInput(body, register.operationId, schema, input.resolveInput)
		}
	}
	const signed = await input.client.request(register.method, register.path, {
		body,
		headers: {},
		operationId: register.operationId,
	})
	const token = tokenOf(signed.responseBody)
	const issued =
		signed.responseBody !== null && typeof signed.responseBody === "object"
			? (signed.responseBody as Record<string, unknown>)
			: {}
	if (signed.status < 200 || signed.status >= 300 || token === null) {
		input.findings
			.attributed(ids)
			.ownedBy(DISPOSABLE_CHECK_ID)
			.backend(
				DISPOSABLE_CHECK_ID,
				read.entity ?? "caller",
				"the disposable signup failed",
				`${register.operationId} returned ${signed.status}.`,
				[signed],
			)
		input.grades.graded(ids, DISPOSABLE_CHECK_ID)
		return
	}
	const disposable = { authorization: `Bearer ${token}` }
	for (const op of ops) {
		const blame = input.findings.attributed([op.operationId]).ownedBy(DISPOSABLE_CHECK_ID)
		const sent = bodyFrom(requestSchemaOf(op, input.model), issued)
		const called = await input.client.request(op.method, op.path, {
			...(Object.keys(sent).length === 0 ? {} : { body: sent }),
			headers: disposable,
			operationId: op.operationId,
		})
		if (called.status < 200 || called.status >= 300) {
			blame.backend(
				DISPOSABLE_CHECK_ID,
				op.entity ?? read.entity ?? "caller",
				"the disposable call failed",
				`${op.operationId} returned ${called.status} for the second user.`,
				[signed, called],
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
		const endsSession = op.invalidates.some((route) => route.endsWith(read.path))
		if (endsSession) {
			const gone = await input.client.request(read.method, read.path, {
				headers: disposable,
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
