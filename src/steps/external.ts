import type { ExternalStep } from "../config/types/steps.ts"
import type { BuiltStep } from "./types.ts"

/** An external step that still needs the scope name its answer binds to. */
export interface ExternalDraft {
	as(name: string): BuiltStep & { toStep(): ExternalStep }
}

/** Something only a person or a browser can do, answered by `hooks.external(name, input)`. */
export function external(name: string, input?: Record<string, unknown>): ExternalDraft {
	const step = (as: string): ExternalStep =>
		input === undefined ? { as, external: name } : { as, external: name, input }
	return { as: (as) => ({ toStep: () => step(as) }) }
}

/** What answers one external: a resolver over its input and the run's context, plus the caller's metadata. */
export type ExternalEntry<Ctx, Meta extends object> = Meta & {
	resolve(input: never, ctx: Ctx): string | null | Promise<string | null>
}

/**
 * Declares the externals a config answers, one typed entry each, so the scenario side and the hook
 * side read one source. Curried so `Ctx` and `Meta` are given while the entries are inferred.
 */
export function defineExternals<Ctx, Meta extends object = object>(): <
	E extends Record<string, ExternalEntry<Ctx, Meta>>,
>(
	entries: E,
) => E {
	return (entries) => entries
}

/** External name → the input its resolver takes (`undefined` for none), for `StepTypes.externals`. */
export type ExternalInputs<E extends Record<string, { resolve: (...args: never[]) => unknown }>> = {
	[N in keyof E]: Parameters<E[N]["resolve"]> extends [infer I, ...unknown[]] ? I : undefined
}
