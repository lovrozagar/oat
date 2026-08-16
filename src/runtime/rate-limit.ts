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

import type { RateLimitSpec } from "../config/define-config.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"

export interface CompiledRateLimitRule {
	test: (method: string, pathname: string) => boolean
	category: string
	rps: number
	/** A 429 against a tag-sourced rule is a claim the document made; against config, it is the
	 * operator's own guess about the environment — only the former is ever a finding. */
	source: "tag" | "config"
}

/**
 * Turns a path template or a simple glob into an anchored regex.
 *
 * `{param}` segments (from an operation's own path template) and bare `*` segments (from a
 * user-written pattern) both become `[^/]+`; `*` inside a segment becomes `[^/]*` so `item-*`
 * matches a prefix without crossing a `/`. Deliberately not a full glob or regex language — the
 * point of a config-level matcher is that it needs no coordination with the document, and a
 * bigger grammar would need documenting on both ends.
 */
function compilePathPattern(pattern: string): RegExp {
	const compiled = pattern
		.split("/")
		.map((segment) => {
			if (segment === "*" || (segment.startsWith("{") && segment.endsWith("}"))) return "[^/]+"
			return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")
		})
		.join("/")
	return new RegExp(`^${compiled}$`)
}

/** Compiles one `match` string against the model — an operationId, a path pattern, or a category. */
function compileMatch(
	match: string,
	model: SpecModel,
): Array<{ test: (method: string, pathname: string) => boolean; category: string }> {
	if (match.startsWith("category:")) {
		const category = match.slice("category:".length).trim()
		return model.operations
			.filter((op) => op.rateLimit?.category === category)
			.map((op) => {
				const pathRegex = compilePathPattern(op.path)
				const method = op.method.toUpperCase()
				return { category, test: (m: string, p: string) => m === method && pathRegex.test(p) }
			})
	}

	const op = model.byOperationId.get(match)
	if (op !== undefined) {
		const pathRegex = compilePathPattern(op.path)
		const method = op.method.toUpperCase()
		return [{ category: match, test: (m: string, p: string) => m === method && pathRegex.test(p) }]
	}

	/* "METHOD /pattern" or a bare "/pattern" matching any method. */
	const spaceAt = match.indexOf(" ")
	const methodPart = spaceAt === -1 ? null : match.slice(0, spaceAt).toUpperCase()
	const pathPart = spaceAt === -1 ? match : match.slice(spaceAt + 1)
	const pathRegex = compilePathPattern(pathPart)
	return [
		{
			category: match,
			test: (m: string, p: string) => (methodPart === null || methodPart === m) && pathRegex.test(p),
		},
	]
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
	configRules: readonly RateLimitSpec[] | undefined,
): CompiledRateLimitRule[] {
	const rules: CompiledRateLimitRule[] = []

	for (const spec of configRules ?? []) {
		for (const compiled of compileMatch(spec.match, model)) {
			/* `compiled.category` is already the right default per match kind — the category name
			 * for `category:x` (so an override merges into the tag's own bucket), the operationId
			 * or raw pattern otherwise. `spec.category` only needs to override that when a plain
			 * path/operationId rule should join an *existing* tag-declared bucket instead of
			 * getting its own. */
			rules.push({ category: spec.category ?? compiled.category, rps: spec.rps, source: "config", test: compiled.test })
		}
	}

	const byCategory = new Map<string, { rps: number | null; ops: OperationModel[] }>()
	for (const op of model.operations) {
		if (op.rateLimit === null) continue
		if (rules.some((rule) => rule.test(op.method.toUpperCase(), op.path))) continue
		const entry = byCategory.get(op.rateLimit.category) ?? { ops: [], rps: null }
		entry.ops.push(op)
		if (op.rateLimit.rps !== null)
			entry.rps = entry.rps === null ? op.rateLimit.rps : Math.min(entry.rps, op.rateLimit.rps)
		byCategory.set(op.rateLimit.category, entry)
	}
	for (const [category, entry] of byCategory) {
		if (entry.rps === null) continue
		for (const op of entry.ops) {
			const pathRegex = compilePathPattern(op.path)
			const method = op.method.toUpperCase()
			rules.push({
				category,
				rps: entry.rps,
				source: "tag",
				test: (m, p) => m === method && pathRegex.test(p),
			})
		}
	}

	return rules
}

/**
 * A token bucket with a queue: concurrent requests against the same category are admitted one at
 * a time, each computing its wait from the bucket's current state rather than racing on it.
 * Burst capacity equals `rps` — up to one second's worth of headroom, the conventional default.
 */
export class RateBucket {
	private tokens: number
	private last = performance.now()
	private queue: Promise<void> = Promise.resolve()

	constructor(private readonly rps: number) {
		this.tokens = rps
	}

	/** Resolves once a token is consumed. Returns `false` when the caller had to wait for it. */
	async acquire(): Promise<boolean> {
		let hadRoom = false
		const previous = this.queue
		this.queue = previous.then(async () => {
			const now = performance.now()
			this.tokens = Math.min(this.rps, this.tokens + ((now - this.last) / 1000) * this.rps)
			this.last = now
			if (this.tokens >= 1) {
				hadRoom = true
				this.tokens -= 1
				return
			}
			const waitMs = ((1 - this.tokens) / this.rps) * 1000
			await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
			this.tokens = 0
			this.last = performance.now()
		})
		await this.queue
		return hadRoom
	}
}

/** Resolves a request's category from the compiled rulebook and paces it through a shared bucket. */
export class RateLimiter {
	private readonly buckets = new Map<string, RateBucket>()

	constructor(private readonly rules: readonly CompiledRateLimitRule[]) {}

	resolve(method: string, pathname: string): CompiledRateLimitRule | undefined {
		return this.rules.find((rule) => rule.test(method, pathname))
	}

	async acquire(rule: CompiledRateLimitRule): Promise<boolean> {
		let bucket = this.buckets.get(rule.category)
		if (bucket === undefined) {
			bucket = new RateBucket(rule.rps)
			this.buckets.set(rule.category, bucket)
		}
		return bucket.acquire()
	}
}
