import type { AuthStep } from "../../config/types/steps.ts"
import type { SecurityScheme } from "../../spec/security/schemes.ts"
import type { CredentialPorts, Sends, StepAnswer } from "../ports.ts"
import type { AcquireCtx } from "../recipes/types.ts"

/* Fake ports that record every call, so tests count logins, refreshes, mints and revokes. */

export const NOW = 1_000_000

export function answerOf(body: unknown, status = 200): StepAnswer {
	return { body, cookies: {}, headers: {}, status }
}

export interface RunCall {
	steps: readonly AuthStep[]
	principal: string
	scope: Readonly<Record<string, string>>
}

export interface Recorded {
	runs: RunCall[]
	calls: Array<{ operationId: string; body?: unknown; sends: Sends; scope?: Readonly<Record<string, string>> }>
	posts: Array<{ url: string; form: Readonly<Record<string, string>> }>
	hooks: Array<{ scheme: string; principal: string }>
}

type Answers = {
	run?: (call: RunCall) => Promise<{ scope: Record<string, string>; answer: StepAnswer }>
	call?: (operationId: string, body: unknown) => Promise<StepAnswer>
	post?: (form: Readonly<Record<string, string>>) => Promise<StepAnswer>
	hook?: CredentialPorts["resolveCredential"]
}

function unexpected(what: string): () => Promise<never> {
	return () => Promise.reject(new Error(`unexpected ${what}`))
}

/** Ports that answer as told and record what they were asked. */
export function fakePorts(answers: Answers = {}): { ports: CredentialPorts; recorded: Recorded } {
	const recorded: Recorded = { calls: [], hooks: [], posts: [], runs: [] }
	const ports: CredentialPorts = {
		operations: {
			call: (input) => {
				recorded.calls.push(input)
				return (answers.call ?? unexpected("call"))(input.operationId, input.body)
			},
		},
		steps: {
			run: (steps, input) => {
				const call = { principal: input.principal, scope: input.scope, steps }
				recorded.runs.push(call)
				return (answers.run ?? unexpected("run"))(call)
			},
		},
		tokens: {
			post: (url, form) => {
				recorded.posts.push({ form, url })
				return (answers.post ?? unexpected("post"))(form)
			},
		},
	}
	const hook = answers.hook
	if (hook !== undefined) {
		ports.resolveCredential = (scheme, principal) => {
			recorded.hooks.push({ principal: principal.id, scheme })
			return hook(scheme, principal)
		}
	}
	return { ports, recorded }
}

export const BEARER: SecurityScheme = { deprecated: false, kind: "bearer", name: "jwt" }

/** An acquire context for one principal and scheme, over the given ports. */
export function ctxOf(ports: CredentialPorts, over: Partial<AcquireCtx> = {}): AcquireCtx {
	return {
		now: () => NOW,
		ports,
		principal: { id: "ann", identity: { email: "ann@x.io", password: "pw" } },
		scheme: BEARER,
		scopes: [],
		sendsOf: (scheme) =>
			Promise.resolve({ cookies: {}, headers: { Authorization: `Bearer ${scheme}-token` }, query: {} }),
		...over,
	}
}

/** The error a promise rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise
	} catch (error) {
		return error as Error
	}
	throw new Error("expected a rejection")
}
