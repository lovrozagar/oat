/**
 * Rate-limit pacing: keeps oat's own traffic under a per-category budget so a documented limit is
 * respected rather than tripped and reported as a backend defect.
 *
 * Two sources compile down to the same shape. `config.rateLimits` is checked first — it is the
 * operator's belief about *this* environment and wins over a general document claim. `x-rate-limit`
 * tags fill in anything the config left uncovered. Either way the result is one ordered list of
 * `{ test, category, rps, source }`: `Client` resolves a request's category by testing it against
 * this list, never by knowing about operationIds or path templates itself.
 */

import type { RateLimitSpec } from "../../config/types/config.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { compileMatch, operationTest, type RequestTest } from "./match.ts"

export interface CompiledRateLimitRule {
	/** `operationId` is the operation the client stamped on the request, when it resolved one. */
	test: RequestTest
	category: string
	rps: number
	/** A 429 against a tag-sourced rule is a claim the document made; against config, it is the
	 * operator's own guess about the environment — only the former is ever a finding.
	 * `"implicit"` is the reactive untagged-write bucket: it exists only after a 429, never as a
	 * documented claim. */
	source: "tag" | "config" | "implicit"
}

function configRules(model: SpecModel, configured: readonly RateLimitSpec[]): CompiledRateLimitRule[] {
	const rules: CompiledRateLimitRule[] = []
	for (const spec of configured) {
		for (const compiled of compileMatch(spec.match, model)) {
			/* `compiled.category` is already the right default per match kind — the category name
			 * for `category:x` (so an override merges into the tag's own bucket), the operationId
			 * or raw pattern otherwise. `spec.category` only needs to override that when a plain
			 * path/operationId rule should join an *existing* tag-declared bucket instead of
			 * getting its own. */
			rules.push({ category: spec.category ?? compiled.category, rps: spec.rps, source: "config", test: compiled.test })
		}
	}
	return rules
}

/** Tagged operations no config rule already covers, grouped by category with its smallest rate. */
function tagCategories(
	model: SpecModel,
	rules: readonly CompiledRateLimitRule[],
): Map<string, { rps: number | null; ops: OperationModel[] }> {
	const byCategory = new Map<string, { rps: number | null; ops: OperationModel[] }>()
	for (const op of model.operations) {
		if (op.rateLimit === null) continue
		if (rules.some((rule) => rule.test(op.method.toUpperCase(), op.path, op.operationId))) continue
		const entry = byCategory.get(op.rateLimit.category) ?? { ops: [], rps: null }
		entry.ops.push(op)
		if (op.rateLimit.rps !== null)
			entry.rps = entry.rps === null ? op.rateLimit.rps : Math.min(entry.rps, op.rateLimit.rps)
		byCategory.set(op.rateLimit.category, entry)
	}
	return byCategory
}

/**
 * Builds the ordered rulebook `Client` consults on every request.
 *
 * Config rules come first, so they win ties against a tag covering the same route. Tag-derived
 * rules are grouped by category and given the *minimum* rps any operation in that category
 * declares — the conservative choice, since exceeding the smallest limit a shared budget names is
 * what actually produces a 429. A category with no known rate anywhere gets no bucket: this only
 * ever adds pacing where a rate is knowable, never removes coverage that existed before it.
 */
export function buildRateLimitRules(
	model: SpecModel,
	configured: readonly RateLimitSpec[] | undefined,
): CompiledRateLimitRule[] {
	const rules = configRules(model, configured ?? [])
	for (const [category, entry] of tagCategories(model, rules)) {
		if (entry.rps === null) continue
		for (const op of entry.ops) rules.push({ category, rps: entry.rps, source: "tag", test: operationTest(op) })
	}
	return rules
}
