import { isRaw, isRecord, type RawOf } from "../../config/types/raw.ts"
import type { OatConfig, OriginSpec } from "../../config/types/config.ts"
import { mappedPairs, type OriginSchemes } from "../origin-recipes.ts"
import type { ResolvedSecurity } from "../../spec/security/requirements.ts"
import type { SecurityScheme } from "../../spec/security/schemes.ts"
import { declaredSchemes } from "./principals.ts"

/* The config's secondary origins, as recipe validation reads them: each one's mapping, schemes and operations. */

type Config = RawOf<OatConfig>

/** What these checks read from a document: its schemes, and what each operation's security asks. */
interface SpecView {
	schemes: ReadonlyMap<string, SecurityScheme>
	operations: ReadonlyArray<{ security: ResolvedSecurity }>
}

/** An origin scheme a recipe shares by name, used with no mapping that says which recipe it takes. */
export function originProblems(
	config: Config,
	origins: Readonly<Record<string, SpecView>>,
	recipes: ReadonlySet<string>,
): string[] {
	const declared = Array.isArray(config.origins) ? config.origins.filter((origin) => isRaw<OriginSpec>(origin)) : []
	return Object.entries(origins).flatMap(([id, view]) => {
		const mapping = declared.find((origin) => origin.id === id)?.security
		const mapped = isRecord(mapping) ? mapping : {}
		return [...view.schemes.keys()]
			.filter((scheme) => recipes.has(scheme) && !(scheme in mapped))
			.map(
				(scheme) =>
					`origins.${id} declares scheme "${scheme}" too; say which recipe it uses: origins[].security: { ${scheme}: "${scheme}" }`,
			)
	})
}

/* Each loaded origin, in config order, with its mapping and its document. */
export type OriginView = OriginSchemes & { id: string; view: SpecView }

/** Each origin the config declares and the run loaded, in config order. */
export function originViews(config: Config, origins: Readonly<Record<string, SpecView>>): OriginView[] {
	const declared = Array.isArray(config.origins) ? config.origins.filter((origin) => isRaw<OriginSpec>(origin)) : []
	return declared.flatMap((origin) => {
		const view = typeof origin.id === "string" ? origins[origin.id] : undefined
		return view === undefined
			? []
			: [{ id: origin.id as string, mapping: origin.security, schemes: view.schemes, view }]
	})
}

/** The primary's schemes, then each origin's, for a recipe that names a scheme none of them maps. */
export function declaredEverywhere(spec: SpecView, views: readonly OriginView[]): string {
	const ofOrigins = views
		.filter((origin) => origin.schemes.size > 0)
		.map((origin) => `; origins.${origin.id} declares: ${[...origin.schemes.keys()].toSorted().join(", ")}`)
	return `${declaredSchemes(spec.schemes.keys())}${ofOrigins.join("")}`
}

/** The recipes some operation needs with scopes: a primary scheme's by name, an origin scheme's by its mapping. */
export function scopedRecipes(spec: SpecView, views: readonly OriginView[]): ReadonlySet<string> {
	const needs = (view: SpecView) =>
		view.operations.flatMap((op) => op.security.alternatives.flat().filter((need) => need.scopes.length > 0))
	const ofOrigins = views.flatMap((origin) => {
		const recipeOf = new Map(mappedPairs(origin))
		return needs(origin.view).flatMap((need) => recipeOf.get(need.scheme) ?? [])
	})
	return new Set([...needs(spec).map((need) => need.scheme), ...ofOrigins])
}
