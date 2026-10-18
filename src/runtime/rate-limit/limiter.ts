/** Resolves a request's category from the compiled rulebook and paces it through a shared bucket. */

import { RateBucket } from "./bucket.ts"
import type { CompiledRateLimitRule } from "./rules.ts"

/** Writes that never declared `x-rate-limit` still share a real backend budget (JWT writes, etc.). */
export const UNTAGGED_WRITE_CATEGORY = "untagged-write"
export const UNTAGGED_CATEGORY = "untagged"

const WRITE_METHODS: ReadonlySet<string> = /* @__PURE__ */ new Set(["POST", "PUT", "PATCH", "DELETE"])

function implicitCategory(method: string): string {
	return WRITE_METHODS.has(method.toUpperCase()) ? UNTAGGED_WRITE_CATEGORY : UNTAGGED_CATEGORY
}

/** The reactive rule for an untagged category: no rate of its own, only the cooldown a 429 opened. */
function implicitRuleFor(category: string): CompiledRateLimitRule {
	return {
		category,
		rps: 0,
		source: "implicit",
		test: (m) => implicitCategory(m) === category,
	}
}

/** The request a rate applies to: its method, its path below the base URL, and its operation. */
export interface RateRoute {
	method: string
	pathname: string
	operationId?: string | undefined
}

export class RateLimiter {
	private readonly buckets = new Map<string, RateBucket>()
	/** Cooldown-only: after an untagged 429, later untagged writes wait this out, then run free. */
	private readonly implicitUntil = new Map<string, number>()
	/** Every request to the origin, whatever its route: the limit an edge in front of it holds. */
	private readonly ceiling: RateBucket | undefined

	constructor(
		private readonly rules: readonly CompiledRateLimitRule[],
		options: { maxRps?: number } = {},
	) {
		this.ceiling = options.maxRps === undefined ? undefined : new RateBucket(options.maxRps)
	}

	/** Waits for room under the origin-wide ceiling, when one is set. */
	async acquireCeiling(): Promise<void> {
		await this.ceiling?.acquire()
	}

	resolve(method: string, pathname: string, operationId?: string): CompiledRateLimitRule | undefined {
		return this.rules.find((rule) => rule.test(method, pathname, operationId))
	}

	/**
	 * After a 429 on an untagged route, later untagged writes share this cooldown so they do not
	 * immediately re-trip. No ongoing rps — we do not know the undocumented rate.
	 */
	implicitRule(method: string): CompiledRateLimitRule | undefined {
		const category = implicitCategory(method)
		if (!this.implicitUntil.has(category)) return undefined
		return implicitRuleFor(category)
	}

	/**
	 * Feed a 429 wait into the matching bucket, or open the implicit untagged cooldown when the
	 * operation never declared a rate. Tags stay the proactive path; this is the reactive one.
	 */
	noteBackoff(route: RateRoute, waitMs: number): CompiledRateLimitRule {
		const { method, pathname, operationId } = route
		const tagged = this.resolve(method, pathname, operationId)
		if (tagged !== undefined) {
			this.bucketFor(tagged).penalize(waitMs)
			return tagged
		}
		const category = implicitCategory(method)
		const until = performance.now() + Math.max(0, waitMs)
		this.implicitUntil.set(category, Math.max(this.implicitUntil.get(category) ?? 0, until))
		return implicitRuleFor(category)
	}

	/** Wait out an implicit 429 cooldown. Returns `false` when the caller had to wait. */
	async waitImplicit(method: string): Promise<boolean> {
		const until = this.implicitUntil.get(implicitCategory(method)) ?? 0
		const now = performance.now()
		if (now >= until) return true
		await new Promise<void>((resolve) => setTimeout(resolve, until - now))
		return false
	}

	async acquire(rule: CompiledRateLimitRule): Promise<boolean> {
		return this.bucketFor(rule).acquire()
	}

	private bucketFor(rule: CompiledRateLimitRule): RateBucket {
		let bucket = this.buckets.get(rule.category)
		if (bucket === undefined) {
			bucket = new RateBucket(rule.rps)
			this.buckets.set(rule.category, bucket)
		}
		return bucket
	}
}
