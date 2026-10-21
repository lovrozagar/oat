/*
 * The operations a recipe issues, refreshes and revokes its credential through: what a security
 * probe anchors on once per scheme, rather than per route. Read from the principal's effective
 * recipe; a step is resolved to an operation by the caller, which knows the document.
 */

import type { Recipe, RecipeKind } from "../config/types/security.ts"
import type { AuthStep } from "../config/types/steps.ts"
import { recipeKind } from "./recipes/acquire.ts"

/** A recipe's kind, and the operations behind its credential that the document declares. */
export interface RecipeAnchors {
	kind: RecipeKind
	/** The step that issues it: the login step whose answer `from` reads, or the mint's operation. */
	issue?: string
	/** The step of the declared refresh that issues the renewed credential. */
	refresh?: string
	/** The declared revoke: a login's `revoke`, or a mint's. */
	revoke?: string
}

/** The documented operation a step calls, or undefined when it calls none this document declares. */
export type StepOperation = (step: AuthStep) => string | undefined

/**
 * The recipe's anchors, or undefined for a recipe that names no kind: a fresh object of operation
 * ids alone, holding no reference to the recipe, so no value, body template or credential is reachable.
 */
export function recipeAnchors(recipe: Partial<Recipe>, operationOf: StepOperation): RecipeAnchors | undefined {
	const kind = recipeKind(recipe)
	if (kind === undefined) return undefined
	const { login, mint, refresh } = recipe
	const found = {
		issue: login === undefined ? mint?.operationId : issuing(login.steps, login.from, operationOf),
		refresh: refresh === undefined ? undefined : issuing(refresh.steps, refresh.from, operationOf),
		revoke: login === undefined ? mint?.revoke : revokeOperationId(login.revoke),
	}
	return { kind, ...Object.fromEntries(Object.entries(found).filter(([, id]) => typeof id === "string")) }
}

/** A login's revoke, named alone or with a body, as its operationId. */
export function revokeOperationId(revoke: string | { operationId: string } | undefined): string | undefined {
	return typeof revoke === "object" ? revoke.operationId : revoke
}

/* The step `from` reads: the last that saved a scope key of that name, else the last step, whose answer it is. */
function issuing(steps: readonly AuthStep[], from: string, operationOf: StepOperation): string | undefined {
	const saving = steps.findLast(
		(step) => "saveAs" in step && step.saveAs !== undefined && Object.hasOwn(step.saveAs, from),
	)
	return operationOf(saving ?? (steps.at(-1) as AuthStep))
}
