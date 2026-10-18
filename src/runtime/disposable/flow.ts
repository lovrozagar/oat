/**
 * The suite principal's signup flow, re-addressed: the same steps sent for a fresh address, so a
 * second user exists without oat knowing how the product signs one up.
 */

import type { AuthFlow, PrincipalAuth } from "../../config/types/principals.ts"
import { isHookAuth } from "../auth-kind.ts"

export function signupOperationId(auth: PrincipalAuth | undefined): string | undefined {
	if (auth === undefined || !("steps" in auth)) return undefined
	for (const step of auth.steps) {
		if ("operationId" in step && typeof step.operationId === "string") return step.operationId
	}
	return undefined
}

export function authFlowOf(auth: PrincipalAuth | undefined): AuthFlow | null {
	if (auth === undefined || isHookAuth(auth) || !("steps" in auth)) return null
	return auth
}

export function signupEmail(spec: AuthFlow): string | undefined {
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
