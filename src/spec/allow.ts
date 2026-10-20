/**
 * The only operations a run may call.
 *
 * Everything else leaves the document before oat reads it, so the matrix, the contract floor,
 * scenarios and teardown cannot reach it: there is nothing to forget to check, because the
 * operation does not exist as far as oat knows. A config that still needs a removed operation —
 * a recipe's login or refresh step, its mint or revoke, a scenario step — is told so before
 * anything is sent.
 */

import type { PrincipalEntry, Recipe } from "../config/types/security.ts"
import type { Scenario } from "../config/types/steps.ts"
import { UsageError } from "../errors/usage-error.ts"
import type { OpenApiDocument } from "./types.ts"

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export function pruneToAllow(
	doc: OpenApiDocument,
	allow: readonly string[],
): { doc: OpenApiDocument; removed: string[] } {
	const kept = new Set(allow)
	const out = structuredClone(doc)
	const paths = (out.paths ?? {}) as Record<string, unknown>
	const seen = new Set<string>()
	const removed: string[] = []
	for (const [route, item] of Object.entries(paths)) {
		if (!isRecord(item)) continue
		for (const method of METHODS) {
			const op = item[method]
			if (!isRecord(op)) continue
			const id = typeof op.operationId === "string" ? op.operationId : `${method.toUpperCase()} ${route}`
			seen.add(id)
			if (kept.has(id)) continue
			removed.push(id)
			delete item[method]
		}
		if (!METHODS.some((method) => isRecord(item[method]))) delete paths[route]
	}
	const unknown = allow.filter((id) => !seen.has(id))
	if (unknown.length > 0) {
		throw new UsageError(`allow names ${unknown.map((id) => `"${id}"`).join(", ")}, which the document does not have`)
	}
	return { doc: out, removed: removed.sort() }
}

/** The operations `steps` call on the document itself that the allowlist removed. */
function removedCalls(kept: ReadonlySet<string>, steps: readonly object[]): string[] {
	return steps
		.filter((step): step is { operationId: string; origin?: unknown } => "operationId" in step)
		.filter((step) => step.origin === undefined && !kept.has(step.operationId))
		.map((step) => step.operationId)
}

/** Recipes by scheme name: the config's `security`, or one principal's overrides of it. */
type Recipes = Readonly<Record<string, Partial<Recipe>>>

/* The removed operations one recipe calls by name: its login and refresh steps, its mint and that mint's revoke. */
function recipeCalls(kept: ReadonlySet<string>, path: string, recipe: Partial<Recipe>): string[] {
	const named = (operationId: string | undefined): string[] =>
		operationId === undefined || kept.has(operationId) ? [] : [operationId]
	return [
		...removedCalls(kept, recipe.login?.steps ?? []).map((id) => `${path} login step "${id}"`),
		...removedCalls(kept, recipe.refresh?.steps ?? []).map((id) => `${path} refresh step "${id}"`),
		...named(recipe.mint?.operationId).map((id) => `${path} mint "${id}"`),
		...named(recipe.mint?.revoke).map((id) => `${path} revoke "${id}"`),
	]
}

function recipesCalls(kept: ReadonlySet<string>, path: string, recipes: Recipes | undefined): string[] {
	return Object.entries(recipes ?? {}).flatMap(([scheme, recipe]) => recipeCalls(kept, `${path}.${scheme}`, recipe))
}

function scenarioProblems(kept: ReadonlySet<string>, scenario: Scenario): string[] {
	if (scenario.origin !== undefined) return []
	return [
		...removedCalls(kept, scenario.steps).map((id) => `scenario "${scenario.id}" step "${id}"`),
		...scenario.covers.filter((id) => !kept.has(id)).map((id) => `scenario "${scenario.id}" covers "${id}"`),
	]
}

/** Every operation the config itself will call by name must survive the allowlist. */
export function assertAllowedReferences(
	kept: ReadonlySet<string>,
	config: {
		security?: Recipes
		principals?: Readonly<Record<string, PrincipalEntry>>
		scenarios?: readonly Scenario[]
	},
): void {
	const problems = [
		...recipesCalls(kept, "security", config.security),
		...Object.entries(config.principals ?? {}).flatMap(([id, principal]) =>
			recipesCalls(kept, `principals.${id}.security`, principal.security),
		),
		...(config.scenarios ?? []).flatMap((scenario) => scenarioProblems(kept, scenario)),
	]
	if (problems.length > 0) {
		throw new UsageError(`allow removes operations the config still calls: ${[...new Set(problems)].join("; ")}`)
	}
}
