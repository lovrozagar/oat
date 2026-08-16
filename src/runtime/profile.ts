/**
 * Cost gating: which operations a run is allowed to touch.
 *
 * `x-cost` and `x-destructive` are parsed onto every `OperationModel` regardless of whether a
 * profile is active — this module is the only thing that reads them for gating. Everything else
 * about an excluded operation reuses the run's existing degraded-mode machinery: nulling the op
 * out of the check context and reporting a named `COVERAGE_GAP`, the same path a genuinely broken
 * create already takes. An excluded operation must never look like a passed check.
 */

import type { ProfileSpec } from "../config/define-config.ts"
import type { OperationModel } from "../spec/graph.ts"

export const BUILTIN_PROFILES: Record<string, ProfileSpec> = {
	cheap: { maxCost: "low" },
	full: {},
}

const COST_RANK: Record<"low" | "medium" | "high", number> = { high: 2, low: 0, medium: 1 }

export interface ResolvedProfile {
	name: string
	spec: ProfileSpec
}

/**
 * Picks the active profile by name, falling back to `"full"` — the same shape as today's
 * behaviour, so a config that never mentions a profile runs identically to before this existed.
 */
export function resolveProfile(
	name: string | undefined,
	configured: Record<string, ProfileSpec> | undefined,
): ResolvedProfile {
	const activeName = name ?? "full"
	const spec = configured?.[activeName] ?? BUILTIN_PROFILES[activeName]
	if (spec === undefined) {
		const known = [...new Set([...Object.keys(BUILTIN_PROFILES), ...Object.keys(configured ?? {})])]
		throw new Error(`oat: profile "${activeName}" is not defined. Known: ${known.join(", ")}`)
	}
	return { name: activeName, spec }
}

/**
 * Why a profile excludes this operation, or `null` when it does not.
 *
 * Checked in order of specificity: an explicit `exclude` entry always wins, `excludeDestructive`
 * next, then the cost ceiling — so a reason a reader sees is always the most direct one, not
 * whichever rule happened to be checked first.
 */
export function excludedByProfile(op: OperationModel, spec: ProfileSpec): string | null {
	if (spec.exclude?.includes(op.operationId) === true) {
		return `excluded by name (operationId: ${op.operationId})`
	}
	if (spec.excludeDestructive === true && op.destructive) return "x-destructive"
	if (spec.maxCost !== undefined && COST_RANK[op.cost] > COST_RANK[spec.maxCost]) {
		return `x-cost: ${op.cost}`
	}
	return null
}
