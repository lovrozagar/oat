/**
 * Signing up the second user: through the suite principal's own flow for a fresh address, or
 * through the document's `x-fresh-principal` operation. `null` when neither can.
 */

import type { AuthFlow } from "../../config/types/principals.ts"
import type { Hooks } from "../../config/types/hooks.ts"
import type { OperationObject } from "../../spec/types.ts"
import { requestSchema } from "../../spec/collection/request.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { createPrincipal, readPath, runAuthSteps } from "../auth.ts"
import type { Exchange } from "../exchange.ts"
import { buildCohort, type CohortMember } from "../fixture.ts"
import { applyResolveInput } from "../input.ts"
import { authFlowOf, disposableAddress, freshSignupFlow, signupEmail, signupOperationId } from "./flow.ts"
import type { DisposableInput, Session } from "./types.ts"
import { bearerHeaders } from "../auth.ts"

/** Top-level strings a signup answered with — tokens a later body may need by the same name. */
export function answered(exchange: Exchange | undefined): Record<string, unknown> {
	const body = exchange?.responseBody
	if (body === null || typeof body !== "object" || Array.isArray(body)) return {}
	return Object.fromEntries(
		Object.entries(body as Record<string, unknown>).filter(([, value]) => typeof value === "string"),
	)
}

export async function signUp(input: DisposableInput, label: string): Promise<Session | null> {
	const flow = authFlowOf(input.authFlow)
	/* Only a flow that signs up an address can sign up a different one; a fixed login would just
	 * hand back the suite user. */
	if (flow !== null && input.hooks !== undefined && signupEmail(flow) !== undefined) {
		return signUpByFlow(input, { flow, hooks: input.hooks, label })
	}
	const register = input.model.operations.find((op) => op.freshPrincipal)
	if (register === undefined) return null
	return signUpByRegister(input, register, label)
}

/** The suite principal's flow, sent for `oat-disp-<nonce>-<label>` at the flow's own domain. */
async function signUpByFlow(
	input: DisposableInput,
	signup: { flow: AuthFlow; hooks: Hooks; label: string },
): Promise<Session> {
	const { flow, hooks, label } = signup
	const email = disposableAddress(flow, `${input.nonce ?? "user"}-${label}`)
	const fresh = freshSignupFlow(flow, email)
	const context = {
		client: input.client,
		hooks,
		model: input.model,
		principalId: `disposable-${label}`,
		...(input.outOfBand === undefined ? {} : { outOfBand: input.outOfBand }),
	}
	/* A flow that yields no credential throws: a principal made here always holds one. */
	const principal = await createPrincipal(`disposable-${label}`, fresh, context)
	const signupId = signupOperationId(fresh)
	const answer = input.client.transcript.findLast(
		(exchange) => exchange.operationId === signupId && exchange.status >= 200 && exchange.status < 300,
	)
	const known: Record<string, unknown> = { ...answered(answer), ...principal.scope, email }
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

/** The document's `x-fresh-principal` operation, sent a body built from its schema. */
async function signUpByRegister(
	input: DisposableInput,
	register: OperationModel,
	label: string,
): Promise<Session | null> {
	/* Every operation of a built model has its raw operation. */
	const schema = requestSchema(input.model.rawOperations.get(register.operationId) as OperationObject)
	let body: Record<string, unknown> = {}
	if (schema !== null) {
		/* One variant asked for, one member back, and its body is always an object. */
		const [member] = buildCohort(schema, input.seed ?? 1, {
			variants: ["baseline"],
			nonce: `${input.nonce ?? "user"}${label}`,
			operationId: register.operationId,
		}) as [CohortMember]
		body = member.body
		if (input.resolveInput !== undefined) {
			body = await applyResolveInput(body, input.resolveInput, { operationId: register.operationId, schema })
		}
	}
	const signup = await input.client.request(register.method, register.path, {
		body,
		headers: {},
		operationId: register.operationId,
	})
	const token = readPath(signup.responseBody, "$.access_token")
	if (signup.status < 200 || signup.status >= 300 || typeof token !== "string" || token === "") return null
	return { headers: () => bearerHeaders(token), known: { ...answered(signup), ...body }, roots: {} }
}
