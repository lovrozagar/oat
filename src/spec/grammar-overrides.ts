/**
 * Filter and sort grammars declared in config, laid over what the document declared or oat inferred.
 *
 * The run's `query.grammar` / `query.sortGrammar` apply to every operation, and an entity's
 * `entities.<name>.query.*` to that entity's operations, outranking the run's. A grammar config
 * names but oat cannot read stops the run: config is the operator's own statement, and carrying on
 * with another grammar would test something they did not ask for.
 */

import { UsageError } from "../errors/usage-error.ts"
import type { QueryConventions } from "./conventions.ts"
import { type FilterGrammarSpec, parseFilterGrammar } from "./filter-render.ts"
import type { SpecModel } from "./graph.ts"
import { parseSortGrammar, SORT_PRESETS, type SortGrammarSpec } from "./sort-render.ts"

import type { DeclaredFilterGrammar, DeclaredSortGrammar } from "../config/types/query.ts"

export type { DeclaredFilterGrammar, DeclaredSortGrammar } from "../config/types/query.ts"

interface DeclaredGrammars {
	grammar?: DeclaredFilterGrammar
	sortGrammar?: DeclaredSortGrammar
}

export interface GrammarConfig {
	query?: DeclaredGrammars
	entities?: Record<string, { query?: DeclaredGrammars } | undefined>
}

type Filter = Pick<QueryConventions, "grammar"> & { filterGrammar?: FilterGrammarSpec }
type Sort = Pick<QueryConventions, "sortGrammar"> & { sortSpec?: SortGrammarSpec }

function resolveFilter(declared: unknown, where: string): Filter {
	if (declared === "postgrest" || declared === "colon" || declared === "equality") return { grammar: declared }
	if (typeof declared !== "object" || declared === null) {
		throw new UsageError(`${where} must be "postgrest", "colon", "equality" or a template object`)
	}
	const parsed = parseFilterGrammar(declared)
	if (!parsed.ok) throw new UsageError(`${where}: ${parsed.error}`)
	return { filterGrammar: parsed.spec, grammar: "template" }
}

function resolveSort(declared: unknown, where: string): Sort {
	if (typeof declared === "string" && Object.hasOwn(SORT_PRESETS, declared)) {
		return { sortGrammar: declared as keyof typeof SORT_PRESETS }
	}
	if (typeof declared !== "object" || declared === null) {
		throw new UsageError(`${where} must be "dotted", "prefixed", "colon", "spaced" or a template object`)
	}
	const parsed = parseSortGrammar(declared)
	if (!parsed.ok) throw new UsageError(`${where}: ${parsed.error}`)
	return { sortGrammar: "template", sortSpec: parsed.spec }
}

interface Resolved {
	filter?: Filter
	sort?: Sort
}

function resolve(declared: DeclaredGrammars | undefined, where: string): Resolved {
	return {
		...(declared?.grammar === undefined ? {} : { filter: resolveFilter(declared.grammar, `${where}.grammar`) }),
		...(declared?.sortGrammar === undefined ? {} : { sort: resolveSort(declared.sortGrammar, `${where}.sortGrammar`) }),
	}
}

export function applyGrammarOverrides(model: SpecModel, config: GrammarConfig): void {
	const global = resolve(config.query, "query")
	const byEntity = new Map<string, Resolved>()
	for (const [name, entity] of Object.entries(config.entities ?? {})) {
		byEntity.set(name, resolve(entity?.query, `entities.${name}.query`))
	}
	for (const op of model.operations) {
		const own = op.entity === null ? undefined : byEntity.get(op.entity)
		const filter = own?.filter ?? global.filter
		const sort = own?.sort ?? global.sort
		if (filter !== undefined) {
			op.conventions.grammar = filter.grammar
			op.conventions.grammarDeclared = true
			if (filter.filterGrammar === undefined) delete op.conventions.filterGrammar
			else op.conventions.filterGrammar = filter.filterGrammar
		}
		if (sort !== undefined) {
			op.conventions.sortGrammar = sort.sortGrammar
			op.conventions.sortDeclared = true
			if (sort.sortSpec === undefined) delete op.conventions.sortSpec
			else op.conventions.sortSpec = sort.sortSpec
		}
	}
}
