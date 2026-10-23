/** Matching `--ops` patterns to operation names, with a suggestion when one matches nothing. */

import { didYouMean } from "../../errors/suggest.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { resolveOperationName } from "../../spec/operation-name.ts"
import { ScopeError } from "./scope-error.ts"

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
	return new RegExp(`^${escaped}$`)
}

export interface Matched {
	ids: string[]
	/** The pattern named one operation outright, rather than globbing. */
	exact: boolean
}

export function matchPattern(pattern: string, model: SpecModel, label: string): Matched {
	if (!pattern.includes("*")) {
		const id = resolveOperationName(pattern, model.byOperationId)
		if (id !== undefined) return { exact: true, ids: [id] }
		throw new ScopeError(
			`oat: --ops "${label}" matches no operation.${didYouMean(pattern, model.byOperationId.keys())}`,
		)
	}
	const re = globToRegExp(pattern)
	const ids = [...model.byOperationId.keys()].filter((id) => re.test(id))
	if (ids.length === 0) throw new ScopeError(`oat: --ops "${label}" matches no operation.`)
	return { exact: false, ids }
}
