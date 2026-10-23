import type {
	PrincipalEntry,
	PrincipalsConfig,
	Recipe,
	RecipeKind,
	SecurityConfig,
} from "../../config/types/security.ts"
import { effectiveRecipe, own } from "../../credentials/effective.ts"
import { recipeKind } from "../../credentials/recipes/acquire.ts"
import { satisfy } from "../../credentials/satisfy.ts"
import type { OperationModel, SpecModel } from "../../spec/graph/types.ts"
import { placementOf } from "../../spec/security/placement.ts"
import type { Requirement, ResolvedSecurity } from "../../spec/security/requirements.ts"
import type { SecurityScheme } from "../../spec/security/schemes.ts"

/*
 * What `doctor` and `plan` say about credentials: where each declared scheme's goes, which recipe
 * makes it, and which principal can send each operation's requirement. The principal is the first
 * in config order for which the run's own `satisfy` succeeds, over the recipes the run reads, so
 * this can never disagree with what a run sends.
 */

/** The config's credentials: its recipes, and its principals in the order the run takes them. */
export interface SecurityCredentials {
	security: SecurityConfig
	principals: PrincipalsConfig
}

/** One declared scheme: where its credential goes, and the recipe that makes it. */
export interface SchemeFact {
	name: string
	kind: SecurityScheme["kind"]
	bearerFormat?: string
	deprecated: boolean
	/** `template` is the recipe's `format` when it has one. Null for a scheme oat cannot send. */
	placement: { in: string; name: string; template: string } | null
	extraPlacements: number
	/** The base recipe's kind, else the first principal override's; null when none names the scheme. */
	recipe: RecipeKind | null
	/** The recipe's `format`, when it sets one. */
	format?: string
	/** Why oat cannot send it. */
	why?: string
}

/** One operation's requirement, and, with a config, who satisfies it or why nobody does. */
export interface OperationFact {
	operationId: string
	source: ResolvedSecurity["source"]
	alternatives: Requirement[][]
	satisfiedBy?: { principal: string; alternative: number }
	/** The first principal's reason, when a later one satisfies the operation instead. */
	alphaUnsatisfied?: string
	unsatisfied?: string
}

/** A scheme and how many operations it concerns. */
export interface SchemeCount {
	name: string
	operations: number
}

/** Operations that share a requirement and a satisfier. */
export interface RequirementGroup {
	requirement: string
	/** Undefined without a config, or for an operation anyone may call. */
	satisfier: string | undefined
	operations: number
}

export interface SecurityFacts {
	/** Whether a config was read: without one, nothing is said of recipes or principals. */
	configured: boolean
	/** The first principal in config order: the run's alpha. */
	alpha: string | undefined
	schemes: SchemeFact[]
	operations: OperationFact[]
	groups: RequirementGroup[]
	/** Supported schemes no recipe names, counted by the operations every alternative of which needs them. */
	noRecipe: SchemeCount[]
	unsupported: Array<SchemeCount & { why: string }>
	/** Schemes a requirement names that the document never declares, counted by the operations naming them. */
	undeclared: SchemeCount[]
	/** Operations no principal can send: with a config, each blocks. */
	blocking: number
}

const NO_PRINCIPAL = "the config names no principal"

/** One requirement alternative, written as doctor and plan print it. `[]` is `anonymous`. */
function alternativeText(alternative: readonly Requirement[]): string {
	if (alternative.length === 0) return "anonymous"
	return alternative
		.map((requirement) =>
			requirement.scopes.length === 0 ? requirement.scheme : `${requirement.scheme}[${requirement.scopes.join(",")}]`,
		)
		.join(" + ")
}

/** An operation's requirement: AND within an alternative, OR between them. */
export function requirementText(alternatives: readonly Requirement[][]): string {
	return alternatives.map(alternativeText).join(" | ")
}

/* The scheme's recipe as the config states it: its base recipe, else the first principal override. */
function recipeOf(name: string, credentials: SecurityCredentials): Partial<Recipe> | undefined {
	const base = own(credentials.security, name)
	if (base !== undefined) return base
	return Object.values(credentials.principals)
		.map((principal) => principal.security?.[name])
		.find((override) => override !== undefined)
}

function schemeFact(scheme: SecurityScheme, credentials: SecurityCredentials | undefined): SchemeFact {
	const recipe = credentials === undefined ? undefined : recipeOf(scheme.name, credentials)
	const placed = placementOf(scheme)
	const format = recipe?.format
	return {
		name: scheme.name,
		kind: scheme.kind,
		...(scheme.kind === "bearer" && scheme.bearerFormat !== undefined ? { bearerFormat: scheme.bearerFormat } : {}),
		deprecated: scheme.deprecated,
		placement: placed === null ? null : { in: placed.in, name: placed.name, template: format ?? placed.template },
		extraPlacements: recipe?.placements?.length ?? 0,
		recipe: (recipe === undefined ? undefined : recipeKind(recipe)) ?? null,
		...(format === undefined ? {} : { format }),
		...(scheme.kind === "unsupported" ? { why: scheme.unsupported } : {}),
	}
}

/* Who sends the operation: the first principal `satisfy` accepts, with the first one's reason when it is not it. */
function satisfaction(op: OperationModel, credentials: SecurityCredentials): Partial<OperationFact> {
	const ids = Object.keys(credentials.principals)
	if (ids.length === 0) {
		return op.security.alternatives.some((alternative) => alternative.length === 0) ? {} : { unsatisfied: NO_PRINCIPAL }
	}
	const reasons: string[] = []
	for (const id of ids) {
		const overrides = (own(credentials.principals, id) as PrincipalEntry).security
		const satisfied = satisfy(op.security, (scheme) =>
			effectiveRecipe(own(credentials.security, scheme), overrides?.[scheme]),
		)
		if ("unsatisfied" in satisfied) {
			reasons.push(satisfied.unsatisfied)
			continue
		}
		const alternative = op.security.alternatives.indexOf(satisfied.alternative)
		return {
			satisfiedBy: { alternative, principal: id },
			...(reasons.length === 0 ? {} : { alphaUnsatisfied: reasons[0] as string }),
		}
	}
	return { unsatisfied: reasons[0] as string }
}

function operationFact(op: OperationModel, credentials: SecurityCredentials | undefined): OperationFact {
	return {
		operationId: op.operationId,
		source: op.security.source,
		alternatives: op.security.alternatives,
		...(credentials === undefined ? {} : satisfaction(op, credentials)),
	}
}

/** Who sends an operation, as printed: undefined without a config, or when anyone may call it. */
export function satisfierText(op: OperationFact, alpha: string | undefined): string | undefined {
	if (op.unsatisfied !== undefined) return `none — ${op.unsatisfied}`
	const by = op.satisfiedBy
	if (by === undefined || requirementText(op.alternatives) === "anonymous") return undefined
	const chosen = op.alternatives[by.alternative] as Requirement[]
	const via = op.alternatives.length > 1 ? ` via ${alternativeText(chosen)}` : ""
	const instead = op.alphaUnsatisfied === undefined ? "" : ` (${alpha}: ${op.alphaUnsatisfied})`
	return `${by.principal}${via}${instead}`
}

/* Keyed by requirement alone: who satisfies an operation depends on nothing else, so its satisfier is the group's. */
function groupsOf(operations: OperationFact[], alpha: string | undefined): RequirementGroup[] {
	const groups = new Map<string, RequirementGroup>()
	for (const op of operations) {
		const requirement = requirementText(op.alternatives)
		const group = groups.get(requirement) ?? { operations: 0, requirement, satisfier: satisfierText(op, alpha) }
		group.operations += 1
		groups.set(requirement, group)
	}
	return [...groups.values()].sort((a, b) => b.operations - a.operations || a.requirement.localeCompare(b.requirement))
}

/* Operations every alternative of which needs `scheme`: without it, nothing can send them. */
function needingOnly(operations: readonly OperationModel[], scheme: string): number {
	return operations.filter((op) =>
		op.security.alternatives.every((alternative) => alternative.some((r) => r.scheme === scheme)),
	).length
}

function named(credentials: SecurityCredentials, scheme: string): boolean {
	if (own(credentials.security, scheme) !== undefined) return true
	return Object.values(credentials.principals).some((principal) => principal.security?.[scheme] !== undefined)
}

/** Everything doctor and plan say about credentials, for `model` and, when there is one, the config's. */
export function securityFacts(model: SpecModel, credentials?: SecurityCredentials): SecurityFacts {
	const schemes = [...model.schemes.values()]
	const operations = model.operations.map((op) => operationFact(op, credentials))
	const alpha = credentials === undefined ? undefined : Object.keys(credentials.principals)[0]
	const undeclared = [...new Set(model.operations.flatMap((op) => op.security.undeclared))].toSorted()
	return {
		alpha,
		blocking: operations.filter((op) => op.unsatisfied !== undefined).length,
		configured: credentials !== undefined,
		groups: groupsOf(operations, alpha),
		noRecipe:
			credentials === undefined
				? []
				: schemes
						.filter((scheme) => scheme.kind !== "unsupported" && !named(credentials, scheme.name))
						.map((scheme) => ({ name: scheme.name, operations: needingOnly(model.operations, scheme.name) })),
		operations,
		schemes: schemes.map((scheme) => schemeFact(scheme, credentials)),
		undeclared: undeclared.map((name) => ({
			name,
			operations: model.operations.filter((op) => op.security.undeclared.includes(name)).length,
		})),
		unsupported: schemes.flatMap((scheme) =>
			scheme.kind === "unsupported"
				? [{ name: scheme.name, operations: needingOnly(model.operations, scheme.name), why: scheme.unsupported }]
				: [],
		),
	}
}

/** The `security` key of doctor's and plan's JSON. `noRecipe` is there only with a config. */
export function securityJson(facts: SecurityFacts): {
	schemes: SchemeFact[]
	operations: OperationFact[]
	noRecipe?: SchemeCount[]
	unsupported: Array<SchemeCount & { why: string }>
	undeclared: SchemeCount[]
} {
	return {
		schemes: facts.schemes,
		operations: facts.operations,
		...(facts.configured ? { noRecipe: facts.noRecipe } : {}),
		unsupported: facts.unsupported,
		undeclared: facts.undeclared,
	}
}
