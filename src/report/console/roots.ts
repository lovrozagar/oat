import type { Hooks } from "../../config/types/hooks.ts"
import { prefixRoots } from "../../spec/graph/roots.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import type { SecurityCredentials } from "./security.ts"

/*
 * Roots are path parameters no create operation makes. A prefix root (`/projects/{project_id}/…`)
 * scopes whole routes and only the config can supply it: through every principal's `scope`, a
 * login's `scope.<parameter>` claim, or `hooks.resolvePathValue`; one it leaves unsupplied blocks.
 * Any other is an id a flow yields (an invite's token, an effect's record), which a run picks up
 * as it goes: listed, never blocking.
 */

/** A root the config supplies, and how. */
export interface SuppliedRoot {
	root: string
	by: string
}

export interface Roots {
	/** Prefix roots nothing in the config supplies: a run cannot seed below them. */
	required: string[]
	supplied: SuppliedRoot[]
	/** Ids no operation creates, which only a flow or `hooks.resolvePathValue` yields. */
	unmade: string[]
}

/** What of the config can supply a root. */
export interface RootsConfig {
	credentials?: SecurityCredentials
	hooks?: Pick<Hooks, "resolvePathValue">
}

/* Who supplies `root`: a hook for every root, else a login claim, else every principal's own scope. */
function supplierOf(root: string, config: RootsConfig): string | undefined {
	if (config.hooks?.resolvePathValue !== undefined) return "hooks.resolvePathValue"
	const { principals = {}, security = {} } = config.credentials ?? {}
	for (const [scheme, recipe] of Object.entries(security)) {
		if (recipe.login?.claims?.[`scope.${root}`] !== undefined) return `login claims (${scheme})`
	}
	const entries = Object.values(principals)
	const scoped = entries.length > 0 && entries.every((principal) => principal.scope?.[root] !== undefined)
	return scoped ? "principal scope" : undefined
}

/** The document's roots: the prefix roots the config supplies, those it still must, and the unmade ids. */
export function rootsOf(model: Pick<SpecModel, "operations" | "entities" | "roots">, config: RootsConfig = {}): Roots {
	const prefix = prefixRoots(model)
	const result: Roots = { required: [], supplied: [], unmade: [] }
	for (const root of model.roots) {
		const by = supplierOf(root, config)
		if (by !== undefined) result.supplied.push({ by, root })
		else if (prefix.has(root)) result.required.push(root)
		else result.unmade.push(root)
	}
	return result
}

/** The roots as the JSON reports carry them: prefix roots, by whether the config supplies them, and unmade ids. */
export function rootsJson(roots: Roots): { prefixRoots: Omit<Roots, "unmade">; unmadeIds: string[] } {
	return { prefixRoots: { required: roots.required, supplied: roots.supplied }, unmadeIds: roots.unmade }
}
