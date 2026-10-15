/**
 * Filter grammars declared in config, laid over what the document declared or oat inferred.
 *
 * The run's `query.grammar` applies to every operation and an entity's
 * `entities.<name>.query.grammar` to that entity's operations, outranking the run's. A grammar
 * config names but oat cannot read stops the run: config is the operator's own statement, and
 * carrying on with another grammar would test something they did not ask for.
 */

import type { QueryConventions } from "./conventions.ts"
import { type FilterGrammarSpec, parseFilterGrammar } from "./filter-render.ts"
import type { SpecModel } from "./graph.ts"

/** A filter grammar as config declares it: a preset name or a template object. */
export type DeclaredFilterGrammar = "postgrest" | "colon" | "equality" | Record<string, unknown>

export interface GrammarConfig {
	query?: { grammar?: DeclaredFilterGrammar }
	entities?: Record<string, { query?: { grammar?: DeclaredFilterGrammar } } | undefined>
}

type Resolved = Pick<QueryConventions, "grammar"> & { filterGrammar?: FilterGrammarSpec }

function resolve(declared: unknown, where: string): Resolved {
	if (declared === "postgrest" || declared === "colon" || declared === "equality") return { grammar: declared }
	if (typeof declared !== "object" || declared === null) {
		throw new Error(`${where} must be "postgrest", "colon", "equality" or a template object`)
	}
	const parsed = parseFilterGrammar(declared)
	if (!parsed.ok) throw new Error(`${where}: ${parsed.error}`)
	return { filterGrammar: parsed.spec, grammar: "template" }
}

export function applyGrammarOverrides(model: SpecModel, config: GrammarConfig): void {
	const global = config.query?.grammar === undefined ? undefined : resolve(config.query.grammar, "query.grammar")
	const byEntity = new Map<string, Resolved>()
	for (const [name, entity] of Object.entries(config.entities ?? {})) {
		const declared = entity?.query?.grammar
		if (declared !== undefined) byEntity.set(name, resolve(declared, `entities.${name}.query.grammar`))
	}
	for (const op of model.operations) {
		const chosen = (op.entity === null ? undefined : byEntity.get(op.entity)) ?? global
		if (chosen === undefined) continue
		op.conventions.grammar = chosen.grammar
		if (chosen.filterGrammar === undefined) delete op.conventions.filterGrammar
		else op.conventions.filterGrammar = chosen.filterGrammar
	}
}
