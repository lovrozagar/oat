/** Resolves a request's category from the compiled rulebook and paces it through a shared bucket. */

import { MUTATING } from "../../spec/methods.ts"
import { RateBucket } from "./bucket.ts"
import type { CompiledRateLimitRule } from "./rules.ts"

/** Writes that never declared `x-rate-limit` still share a real backend budget (JWT writes, etc.). */
export const UNTAGGED_WRITE_CATEGORY = "untagged-write"
export const UNTAGGED_CATEGORY = "untagged"

/**
 * The longest a 429's cooldown spreads the writes it held past its end. Released at one instant, they
 * would land together and trip the limit again, in lockstep; each leaves at a random point instead,
 * over the cooldown's own length or this, whichever is shorter.
 */
export const IMPLICIT_RELEASE_SPREAD_MS = 10_000

function implicitCategory(method: string): string {
	return MUTATING.has(method.toUpperCase()) ? UNTAGGED_WRITE_CATEGORY : UNTAGGED_CATEGORY
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

/** An untagged cooldown: when its first 429 opened it, and when it ends. */
interface Cooldown {
	openedAt: number
	until: number
}

export class RateLimiter {
	private readonly buckets = new Map<string, RateBucket>()
	/** Cooldown-only: after an untagged 429, later untagged writes wait this out, then run free. */
	private readonly implicitUntil = new Map<string, Cooldown>()
	/** Every request to the origin, whatever its route: the limit an edge in front of it holds. */
	private readonly ceiling: RateBucket | undefined
	/** Where in its spread each held write leaves, from 0 to 1. */
	private readonly random: () => number

	constructor(
		private readonly rules: readonly CompiledRateLimitRule[],
		options: { maxRps?: number; random?: () => number } = {},
	) {
		this.ceiling = options.maxRps === undefined ? undefined : new RateBucket(options.maxRps)
		this.random = options.random ?? Math.random
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
		const now = performance.now()
		const until = now + Math.max(0, waitMs)
		const open = this.implicitUntil.get(category)
		/* A 429 inside an open cooldown extends it from when it opened; one after it lapsed opens anew. */
		this.implicitUntil.set(
			category,
			open !== undefined && now < open.until
				? { openedAt: open.openedAt, until: Math.max(open.until, until) }
				: { openedAt: now, until },
		)
		return implicitRuleFor(category)
	}

	/**
	 * Wait out an implicit 429 cooldown, and then a random part of its spread. Returns `false` when the
	 * caller had to wait.
	 */
	async waitImplicit(method: string): Promise<boolean> {
		const cooldown = this.implicitUntil.get(implicitCategory(method))
		const now = performance.now()
		if (cooldown === undefined || now >= cooldown.until) return true
		const spread = Math.min(cooldown.until - cooldown.openedAt, IMPLICIT_RELEASE_SPREAD_MS)
		const leaves = cooldown.until + this.random() * spread
		await new Promise<void>((resolve) => setTimeout(resolve, leaves - now))
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
