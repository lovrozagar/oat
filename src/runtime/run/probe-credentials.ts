/*
 * The credentials an operation check probes with, over the run's store: a dedicated credential that
 * is never a principal's own session, and the value a principal's own credential holds, to derive a
 * forged one from. What the store refuses is the check's reason to stay untested.
 */

import type {
	DedicatedCredential,
	ProbeCredentials,
	Probed,
	Replayed,
	Rotation,
} from "../checks/core/operation-context.ts"
import { recipeAnchors, type RecipeAnchors, type StepOperation } from "../../credentials/anchors.ts"
import { effectiveRecipe } from "../../credentials/effective.ts"
import type { DedicatedHeld, Rotated } from "../../credentials/store.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { pathTemplateParams } from "../../spec/routes.ts"
import { messageOf } from "../../errors/message.ts"
import type { RunContext } from "./context.ts"

/** The run's probe credentials. */
export function probeCredentials(ctx: Pick<RunContext, "store" | "model" | "options">): ProbeCredentials {
	const { store } = ctx
	return {
		dedicated: async ({ reusable, ...key }) => {
			const held = await store.acquireDedicated(key, { reusable: reusable === true })
			return "blocked" in held ? { untested: held.blocked } : dedicatedOf(held)
		},
		held: async (request): Promise<Probed<{ value: string }>> => {
			const held = await store.acquire(request)
			return "blocked" in held ? { untested: held.blocked } : { value: held.value }
		},
		recipe: (request) => anchorsOf(ctx, request),
	}
}

/* The principal's effective recipe for the scheme, read for the operations behind its credential. */
function anchorsOf(
	{ model, options, store }: Pick<RunContext, "store" | "model" | "options">,
	{ principal, scheme }: { principal: string; scheme: string },
): Probed<RecipeAnchors> {
	if (!Object.hasOwn(store.principals, principal)) return { untested: `no principal "${principal}" in the config` }
	const base = Object.hasOwn(options.security ?? {}, scheme) ? options.security?.[scheme] : undefined
	const recipe = effectiveRecipe(base, store.principals[principal]?.security?.[scheme])
	const anchors = recipe === undefined ? undefined : recipeAnchors(recipe, stepOperation(model))
	return anchors ?? { untested: `principal "${principal}" has no recipe for the "${scheme}" scheme` }
}

/** A step's operation in this document: its operationId, or the operation documented at a raw step's method and path. */
export function stepOperation(model: SpecModel): StepOperation {
	return (step) => {
		if ("origin" in step && step.origin !== undefined) return undefined
		if ("operationId" in step) return step.operationId
		if (!("method" in step)) return undefined
		const method = step.method.toUpperCase()
		return model.operations.find((op) => op.method === method && pathTemplateParams(op.path, step.path) !== null)
			?.operationId
	}
}

function dedicatedOf(held: DedicatedHeld): DedicatedCredential {
	const credential: DedicatedCredential = {
		actor: { principal: held.principal },
		owner: held.owner,
		scheme: held.scheme,
		value: held.credential.value,
	}
	if (held.revoke !== undefined) credential.revoke = held.revoke
	const { rotate } = held
	if (rotate !== undefined) credential.rotate = async () => rotationOf(await rotate())
	return credential
}

function rotationOf(rotated: Rotated): Rotation {
	return {
		replay: (): Promise<Replayed> =>
			rotated.replay().then(
				() => ({ accepted: true }),
				(error: unknown) => ({ accepted: false, reason: messageOf(error) }),
			),
		value: rotated.credential.value,
	}
}
