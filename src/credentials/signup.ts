/*
 * Whether renewing a login would sign its principal up again. A login recipe with no `refresh` is
 * renewed by running its steps once more, and a refused refresh falls back to the same; when a step
 * calls an operation that makes an account (`accountMakersOf`), that would register another one,
 * so the store refuses the renewal.
 */

import type { Recipe } from "../config/types/security.ts"
import type { AuthStep } from "../config/types/steps.ts"
import type { SignupOperation } from "../spec/sign-up.ts"

/**
 * Whether a recipe's login steps call one of the account makers on the primary origin: by its
 * operationId, or by a raw step to its method and path. A step on another origin calls another
 * document's operation.
 */
export function signsUp(recipe: Partial<Recipe>, makers: readonly SignupOperation[]): boolean {
	if (recipe.login === undefined) return false
	return recipe.login.steps.some((step) => makers.some((maker) => callsSignup(step, maker)))
}

function callsSignup(step: AuthStep, signup: SignupOperation): boolean {
	if ("origin" in step && step.origin !== undefined) return false
	if ("operationId" in step) return step.operationId === signup.operationId
	return "method" in step && step.method.toUpperCase() === signup.method.toUpperCase() && step.path === signup.path
}
