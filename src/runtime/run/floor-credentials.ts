/*
 * Who the contract floor sends a credential operation as. An operation a recipe names (a login or
 * refresh step, a revoke, a mint) can end, rotate or spend the session it is sent with, so it is
 * never sent with a principal's own: a dedicated credential sends it, or nobody where the operation
 * needs none. What a recipe names is the whole class; a route's name says nothing. A sign-in step's
 * fields that name the principal are listed too: the floor fills them with an identity no account holds.
 */

import type { Recipe } from "../../config/types/security.ts"
import type { AuthStep } from "../../config/types/steps.ts"
import { revokeOperationId } from "../../credentials/anchors.ts"
import { effectiveRecipe } from "../../credentials/effective.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import type { Requirement } from "../../spec/security/requirements.ts"
import type { ProbeCredentials } from "../checks/core/operation-context.ts"
import type { FloorCredentials } from "../contract/types.ts"
import type { RunContext } from "./context.ts"
import { probeCredentials, stepOperation } from "./probe-credentials.ts"

type FloorContext = Pick<RunContext, "store" | "model" | "options">

/** The floor's credential operations, and a dedicated actor of `principal`'s for each. */
export function floorCredentials(ctx: FloorContext, principal: string): FloorCredentials {
	const probe = probeCredentials(ctx)
	return {
		actorFor: (op) => actorFor(probe, principal, op),
		identityFields: identityFieldsOf(recipesOf(ctx), stepOperation(ctx.model)),
		operations: credentialOperations(ctx),
	}
}

/**
 * Every operation a principal's effective recipe names, however a step names it (by operationId, or by
 * method and path): its login and refresh steps, its revokes, and its mint. No probe sends one.
 */
export function credentialOperations(ctx: FloorContext): Set<string> {
	const operationOf = stepOperation(ctx.model)
	return new Set(recipesOf(ctx).flatMap((recipe) => namedBy(recipe, operationOf)))
}

/* Every principal's effective recipe, for every scheme the config covers. */
function recipesOf({ options, store }: FloorContext): Partial<Recipe>[] {
	return Object.entries(options.security ?? {}).flatMap(([scheme, base]) =>
		/* A configured base always yields a recipe. */
		Object.values(store.principals).map((entry) => effectiveRecipe(base, entry.security?.[scheme]) as Partial<Recipe>),
	)
}

/* The body fields each sign-in step (a login or refresh step) fills from the principal, by its operation. */
function identityFieldsOf(
	recipes: readonly Partial<Recipe>[],
	operationOf: (step: AuthStep) => string | undefined,
): Map<string, string[][]> {
	const fields = new Map<string, Map<string, string[]>>()
	for (const step of recipes.flatMap((recipe) => [...(recipe.login?.steps ?? []), ...(recipe.refresh?.steps ?? [])])) {
		const id = operationOf(step)
		if (id === undefined || !("body" in step)) continue
		const known = fields.get(id) ?? new Map<string, string[]>()
		/* A body that is one string, a form say, has no field to fill. */
		for (const path of principalPaths(step.body, [])) if (path.length > 0) known.set(JSON.stringify(path), path)
		if (known.size > 0) fields.set(id, known)
	}
	return new Map([...fields].map(([id, known]) => [id, [...known.values()]]))
}

/* The paths, through plain objects, of every string that reads a `{principal.<key>}`. */
function principalPaths(value: unknown, at: string[]): string[][] {
	if (typeof value === "string") return value.includes("{principal.") ? [at] : []
	if (value === null || typeof value !== "object" || Array.isArray(value)) return []
	return Object.entries(value).flatMap(([key, item]) => principalPaths(item, [...at, key]))
}

/* The operations one recipe names: its login and refresh steps, its revokes, and its mint. */
function namedBy(recipe: Partial<Recipe>, operationOf: (step: AuthStep) => string | undefined): string[] {
	const steps = [...(recipe.login?.steps ?? []), ...(recipe.refresh?.steps ?? [])]
	const ids = [
		...steps.map(operationOf),
		revokeOperationId(recipe.login?.revoke),
		recipe.mint?.operationId,
		recipe.mint?.revoke,
	]
	return ids.filter((id): id is string => id !== undefined)
}

/* Nobody, for an operation that admits it; else a dedicated credential for the first alternative that can have one. */
async function actorFor(
	probe: ProbeCredentials,
	principal: string,
	op: OperationModel,
): Promise<Awaited<ReturnType<FloorCredentials["actorFor"]>>> {
	const { alternatives } = op.security
	if (alternatives.some((alternative) => alternative.length === 0)) return { as: { anonymous: true } }
	const reasons: string[] = []
	for (const alternative of alternatives) {
		const [only] = alternative as [Requirement, ...Requirement[]]
		if (alternative.length > 1) {
			reasons.push(`${alternative.map((r) => r.scheme).join(" + ")}: a dedicated credential holds one scheme`)
			continue
		}
		const held = await probe.dedicated({ principal, scheme: only.scheme, scopes: only.scopes })
		if (!("untested" in held)) return { as: { principal: held.actor.principal, scheme: held.scheme } }
		reasons.push(`${only.scheme}: ${held.untested}`)
	}
	return {
		untested: `a credential operation is sent with a dedicated credential, never ${principal}'s own session, and none could be had: ${reasons.join("; ")}`,
	}
}
