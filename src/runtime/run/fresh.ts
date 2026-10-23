/*
 * A fresh principal, signed up by the run (D7): the operation the document marks
 * `x-fresh-principal`, sent a body generated from its schema. The body's values bind into the
 * principal's identity, never its tenant or scope, so its login recipe can read `{principal.email}`;
 * a tenant or a scope parameter comes only from a login's claims. When the answer carries a value at
 * the effective login recipe's `from`, that is the credential; otherwise the recipe acquires one.
 * A configured `fresh: true` principal and every disposable session are made this way, and bound in
 * the store as principals of their own, so they refresh and retry a 401 like any other.
 */

import type { PrincipalEntry } from "../../config/types/security.ts"
import { effectiveRecipe } from "../../credentials/effective.ts"
import { readAnswer } from "../../credentials/read.ts"
import { requestSchema } from "../../spec/collection/request.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import type { OperationObject } from "../../spec/types.ts"
import { buildCohort, type CohortMember } from "../fixture.ts"
import { applyResolveInput } from "../input.ts"
import { answerOf } from "../steps/engine.ts"
import type { Exchange } from "../exchange.ts"
import type { Connected } from "./context.ts"

/** A principal signed up by the run, and what its signup sent and answered, by name. */
export interface Provisioned {
	id: string
	/** The body sent and the answer's top-level strings: a later body field of the same name gets them. */
	known: Record<string, unknown>
}

/** Who to sign up: its id, its config entry, and the label that keeps its generated values its own. */
export interface FreshRequest {
	id: string
	entry: PrincipalEntry
	label: string
}

/* Keys that grade or authenticate a principal: a signup body's values never set them. */
const RESERVED: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"created",
	"fresh",
	"inviteAs",
	"rank",
	"readOnly",
	"scope",
	"security",
	"tenant",
])

/** Signs `request.id` up and binds it in the run's store; BLOCKED with the reason when it cannot. */
export async function provision(ctx: Connected, request: FreshRequest): Promise<Provisioned | { blocked: string }> {
	const { id, entry } = request
	const register = ctx.model.operations.find((op) => op.freshPrincipal)
	if (register === undefined) {
		return { blocked: `signup for ${id}: the document marks no x-fresh-principal operation` }
	}
	const body = await signupBody(ctx, register, request.label)
	const signup = await ctx.client.view({ purpose: "auth" }).request(register.method, register.path, {
		as: { anonymous: true },
		body,
		operationId: register.operationId,
	})
	if (signup.status < 200 || signup.status >= 300) {
		return { blocked: `signup for ${id} by ${register.operationId}: answered ${signup.status}` }
	}
	return { id, known: await bindSignUp(ctx, { body, entry, id, signup }) }
}

/**
 * Binds the account a sign-up made as principal `id`: what the body sent becomes its identity, and a
 * credential the answer carries at a recipe's `from` is held for it; otherwise its recipe acquires
 * one. What the body sent and the answer's top-level strings, by name.
 */
export async function bindSignUp(
	ctx: Connected,
	made: { id: string; entry: PrincipalEntry; body: Record<string, unknown>; signup: Exchange },
): Promise<Record<string, unknown>> {
	const { id, entry, body, signup } = made
	const identity = Object.fromEntries(Object.entries(body).filter(([key]) => !RESERVED.has(key)))
	ctx.store.enroll(id, { ...entry, ...identity })
	const answer = answerOf(signup)
	/* What the signup answered beside the credential, a refresh_token say, is what its refresh runs from. */
	const saved = stringsOf(signup.responseBody)
	for (const [scheme, base] of Object.entries(ctx.options.security ?? {})) {
		const from = effectiveRecipe(base, entry.security?.[scheme])?.login?.from
		const value = from === undefined ? undefined : readAnswer(answer, from)
		/* A value the scheme cannot place is not held, and the recipe's own acquire says why. */
		if (value !== undefined) await ctx.store.adopt({ principal: id, scheme, scope: saved, value })
	}
	return { ...saved, ...body }
}

/* The register operation's body: one baseline member of its schema, then `resolveInput`. */
async function signupBody(ctx: Connected, register: OperationModel, label: string): Promise<Record<string, unknown>> {
	/* Every operation of a built model has its raw operation. */
	const raw = ctx.model.rawOperations.get(register.operationId) as OperationObject
	const schema = requestSchema(raw)
	if (schema === null) return {}
	/* One variant asked for, one member back, and its body is always an object. */
	const [member] = buildCohort(schema, ctx.seed, {
		nonce: `${ctx.nonce}${label}`,
		operationId: register.operationId,
		variants: ["baseline"],
	}) as [CohortMember]
	return applyResolveInput(member.body, ctx.hooks.resolveInput, { operationId: register.operationId, schema })
}

/* The top-level strings of an answer's body. */
function stringsOf(body: unknown): Record<string, string> {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return {}
	return Object.fromEntries(
		Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	)
}
