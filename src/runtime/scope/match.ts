/** Matching `--ops` patterns to operationIds, with a suggestion when one matches nothing. */

import { nearest } from "../../errors/suggest.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { ScopeError } from "./scope-error.ts"

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
	return new RegExp(`^${escaped}$`)
}

export function didYouMean(name: string, candidates: Iterable<string>): string {
	const close = nearest(name, candidates)
	return close.length === 0 ? "" : ` Did you mean: ${close.join(", ")}?`
}

export interface Matched {
	ids: string[]
	/** The pattern named one operation outright, rather than globbing. */
	exact: boolean
}

export function matchPattern(pattern: string, model: SpecModel, label: string): Matched {
	if (!pattern.includes("*")) {
		if (model.byOperationId.has(pattern)) return { exact: true, ids: [pattern] }
		throw new ScopeError(
			`oat: --ops "${label}" matches no operation.${didYouMean(pattern, model.byOperationId.keys())}`,
		)
	}
	const re = globToRegExp(pattern)
	const ids = [...model.byOperationId.keys()].filter((id) => re.test(id))
	if (ids.length === 0) throw new ScopeError(`oat: --ops "${label}" matches no operation.`)
	return { exact: false, ids }
}
