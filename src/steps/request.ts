import type { ScenarioAssert, ScenarioRequestStep } from "../config/types/steps.ts"
import type { BuiltStep } from "./types.ts"

const OBSERVES_FIRST =
	"observes() names what an assert proves: call it after equals, contains, excludes, omits or atLeast"

/**
 * One request step under construction: an operation call or a raw request, then what to save from
 * its response and what that response must show. Each call returns a new builder, so a step shared
 * by two branches of a chain stays as it was.
 */
export class RequestBuilder<Observed extends string> implements BuiltStep {
	readonly #step: ScenarioRequestStep
	readonly #asserts: readonly ScenarioAssert[]

	constructor(step: ScenarioRequestStep, asserts: readonly ScenarioAssert[] = []) {
		this.#step = step
		this.#asserts = asserts
	}

	/** Binds response parts into the scope (`saveAs`), merged with earlier saves. */
	save(names: Record<string, string>): RequestBuilder<Observed> {
		return this.#with({ saveAs: { ...this.#step.saveAs, ...names } })
	}

	/** Binds claims out of the JWT at `token` (`saveClaimsFrom`). */
	claims(token: string, bind: Record<string, string>): RequestBuilder<Observed> {
		return this.#with({ saveClaimsFrom: { bind, token } })
	}

	/** The statuses the response may have (`expect`). */
	status(...codes: number[]): RequestBuilder<Observed> {
		return this.#with({ expect: codes })
	}

	/** Re-sends until the asserts pass or `within` runs out. */
	poll(within: string, everyMs?: number): RequestBuilder<Observed> {
		return this.#with({ poll: everyMs === undefined ? { within } : { everyMs, within } })
	}

	/** Sends only this security scheme's credential. */
	scheme(name: string): RequestBuilder<Observed> {
		return this.#with({ scheme: name })
	}

	equals(from: string, text: string): RequestBuilder<Observed> {
		return this.#assert({ equals: text, from })
	}

	contains(from: string, text: string): RequestBuilder<Observed> {
		return this.#assert({ contains: text, from })
	}

	excludes(from: string, text: string): RequestBuilder<Observed> {
		return this.#assert({ excludes: text, from })
	}

	omits(from: string, text: string): RequestBuilder<Observed> {
		return this.#assert({ from, omits: text })
	}

	atLeast(from: string, floor: number): RequestBuilder<Observed> {
		return this.#assert({ atLeast: floor, from })
	}

	/** Earlier operations the assert just before this proves; none writes an empty list. */
	observes(...operationIds: Observed[]): RequestBuilder<Observed> {
		const last = this.#asserts.at(-1)
		if (last === undefined) throw new Error(OBSERVES_FIRST)
		const observes = [...(last.observes ?? []), ...operationIds]
		return new RequestBuilder(this.#step, [...this.#asserts.slice(0, -1), { ...last, observes }])
	}

	toStep(): ScenarioRequestStep {
		const [only, ...more] = this.#asserts
		if (only === undefined) return this.#step
		return { ...this.#step, assert: more.length === 0 ? only : [...this.#asserts] }
	}

	#with(part: Partial<ScenarioRequestStep>): RequestBuilder<Observed> {
		return new RequestBuilder({ ...this.#step, ...part } as ScenarioRequestStep, this.#asserts)
	}

	#assert(assert: ScenarioAssert): RequestBuilder<Observed> {
		return new RequestBuilder(this.#step, [...this.#asserts, assert])
	}
}
