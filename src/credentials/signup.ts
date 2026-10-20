/*
 * Whether renewing a login would sign its principal up again. A login recipe with no `refresh` is
 * renewed by running its steps once more; when a step calls the operation the document marks
 * `x-fresh-principal`, that would register another account, so the store refuses the renewal.
 */

import type { Recipe } from "../config/types/security.ts"
import type { AuthStep } from "../config/types/steps.ts"
import type { SpecModel } from "../spec/graph/types.ts"

/** The operation that signs a fresh principal up: the one the document marks `x-fresh-principal`. */
export interface SignupOperation {
	operationId: string
	method: string
	/** Its path template, below the primary base URL. */
	path: string
}

/** The document's signup operation, the one it marks `x-fresh-principal`, as the store's `signup` option takes it. */
export function signupOf(model: Pick<SpecModel, "operations">): { signup?: SignupOperation } {
	const fresh = model.operations.find((op) => op.freshPrincipal)
	return fresh === undefined
		? {}
		: { signup: { method: fresh.method, operationId: fresh.operationId, path: fresh.path } }
}

/**
 * Whether a recipe's login steps call the signup operation on the primary origin: by its operationId,
 * or by a raw step to its method and path. A step on another origin calls another document's operation.
 */
export function signsUp(recipe: Partial<Recipe>, signup: SignupOperation | undefined): boolean {
	if (signup === undefined || recipe.login === undefined) return false
	return recipe.login.steps.some((step) => callsSignup(step, signup))
}

function callsSignup(step: AuthStep, signup: SignupOperation): boolean {
	if ("origin" in step && step.origin !== undefined) return false
	if ("operationId" in step) return step.operationId === signup.operationId
	return "method" in step && step.method.toUpperCase() === signup.method.toUpperCase() && step.path === signup.path
}
