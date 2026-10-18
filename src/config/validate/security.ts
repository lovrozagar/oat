import type { RecipeKind } from "../types/security.ts"
import { nearest } from "../../errors/suggest.ts"
import type { ResolvedSecurity } from "../../spec/security/requirements.ts"
import type { SecurityScheme } from "../../spec/security/schemes.ts"
import { effectiveRecipe } from "../../credentials/effective.ts"
import type { Recipe } from "../types/security.ts"
import { principalProblems, removedProblems } from "./principals.ts"
import { kindShapeProblems } from "./recipe-shape.ts"

/*
 * The 0.25.0 credentials config, checked against the documents it runs on: one recipe of one kind
 * per declared scheme, mints that resolve without a loop, principals that supply what recipes
 * use. Every problem names the path and the fix; the CLI exits 2 on any, with nothing sent.
 */

/** What validation reads from a document. */
export interface SpecView {
	schemes: ReadonlyMap<string, SecurityScheme>
	operations: ReadonlyArray<{ operationId: string; security: ResolvedSecurity }>
	/** The document still carries the removed `x-auth-flows` tag. */
	authFlows: boolean
}

type Raw = Record<string, unknown>

const KINDS: readonly RecipeKind[] = ["login", "mint", "static", "hook", "oauth2"]
const LOCATIONS: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["header", "query", "cookie"])

const isRecord = (value: unknown): value is Raw => value !== null && typeof value === "object" && !Array.isArray(value)

function kindProblems(path: string, recipe: Raw): string[] {
	const present = KINDS.filter((kind) => recipe[kind] !== undefined)
	if (present.length === 1) return []
	if (present.length === 0) return [`${path} needs exactly one of ${KINDS.join(", ")}`]
	return [`${path} has ${present.join(" and ")}; keep exactly one`]
}

function validExpiry(value: unknown): boolean {
	if (typeof value === "number") return value > 0
	return isRecord(value) && typeof value.from === "string"
}

const validPlacement = (value: unknown): boolean =>
	isRecord(value) &&
	LOCATIONS.has(value.in) &&
	typeof value.name === "string" &&
	(value.template === undefined || (typeof value.template === "string" && value.template.includes("{credential}")))

function optionProblems(path: string, recipe: Raw): string[] {
	const problems: string[] = []
	if (recipe.expiresIn !== undefined && !validExpiry(recipe.expiresIn)) {
		problems.push(`${path}.expiresIn must be seconds above 0 or { from: <json path> }`)
	}
	const holds = recipe.holds
	if (holds !== undefined && !(Array.isArray(holds) && holds.every((scope) => typeof scope === "string"))) {
		problems.push(`${path}.holds must be a list of scope names`)
	}
	if (recipe.placements !== undefined && !Array.isArray(recipe.placements)) {
		problems.push(`${path}.placements must be a list`)
	}
	const placements: unknown[] = Array.isArray(recipe.placements) ? recipe.placements : []
	placements.forEach((placement, index) => {
		if (!validPlacement(placement)) {
			problems.push(
				`${path}.placements[${index}] must be { in: header | query | cookie, name, template? containing {credential} }`,
			)
		}
	})
	return problems
}

function oauth2Problems(path: string, oauth2: Raw, scheme: SecurityScheme): string[] {
	if (scheme.kind !== "oauth2") return [`${path}.oauth2 needs an oauth2 scheme; ${scheme.name} is ${scheme.kind}`]
	const flow = scheme.flows[oauth2.flow as keyof typeof scheme.flows]
	return flow?.tokenUrl === undefined
		? [`${path}.oauth2.flow "${String(oauth2.flow)}" is not a flow scheme ${scheme.name} declares with a tokenUrl`]
		: []
}

/** The chain of `mint.with` from `start`, ending where it leaves the mints or returns to `start`. */
function mintChain(start: string, security: Raw): string[] {
	const chain = [start]
	let at = start
	for (;;) {
		const next = (security[at] as { mint?: { with?: unknown } } | undefined)?.mint?.with
		if (typeof next !== "string" || !isRecord(security[next])) return chain
		chain.push(next)
		if (next === start || chain.length > Object.keys(security).length) return chain
		at = next
	}
}

/** What a recipe is checked against: the base recipes, the document, and whether a credential hook exists. */
interface Against {
	security: Raw
	spec: SpecView
	hasHook: boolean
}

const names = (spec: SpecView, operationId: string): boolean =>
	spec.operations.some((op) => op.operationId === operationId)

/* References a mint makes, once its fields are strings: the shape check reports them otherwise. */
function mintProblems(path: string, name: string, mint: Raw, against: Against): string[] {
	const { security, spec } = against
	const problems: string[] = []
	if (typeof mint.with === "string" && !isRecord(security[mint.with])) {
		problems.push(`${path}.mint.with names "${mint.with}", which has no recipe`)
	} else if (typeof mint.with === "string") {
		const chain = mintChain(name, security)
		if (chain.at(-1) === name) problems.push(`${path}.mint.with forms a loop: ${chain.join(" → ")}`)
	}
	if (typeof mint.revoke === "string" && !names(spec, mint.revoke)) {
		problems.push(`${path}.mint.revoke "${mint.revoke}" names no operation`)
	}
	if (typeof mint.operationId !== "string") return problems
	if (!names(spec, mint.operationId)) {
		problems.push(`${path}.mint.operationId "${mint.operationId}" names no operation`)
	} else if (JSON.stringify(mint.body ?? null).includes("{scopes}")) {
		const scoped = spec.operations.some((op) =>
			op.security.alternatives.flat().some((need) => need.scheme === name && need.scopes.length > 0),
		)
		if (!scoped) problems.push(`${path}.mint.body asks for {scopes}, but no operation needs ${name} with scopes`)
	}
	return problems
}

function recipeProblems(path: string, name: string, recipe: unknown, against: Against): string[] {
	const { spec } = against
	const scheme = spec.schemes.get(name)
	if (scheme === undefined) {
		const close = nearest(name, spec.schemes.keys())[0]
		const hint = close === undefined ? "" : ` Did you mean "${close}"?`
		const declared = [...spec.schemes.keys()].toSorted().join(", ")
		return [`${path} names no scheme in the document.${hint} The document declares: ${declared}`]
	}
	if (scheme.kind === "unsupported") return [`${path}: ${scheme.unsupported}`]
	if (!isRecord(recipe)) return [`${path} must be a recipe object`]
	const kind = kindProblems(path, recipe)
	if (kind.length > 0) return kind
	return [
		...optionProblems(path, recipe),
		...kindShapeProblems(path, recipe, scheme, against.hasHook),
		...(isRecord(recipe.oauth2) ? oauth2Problems(path, recipe.oauth2, scheme) : []),
		...(isRecord(recipe.mint) ? mintProblems(path, name, recipe.mint, against) : []),
	]
}

/* Each principal's override, checked as the recipe that principal will actually use. */
function overrideProblems(config: Raw, against: Against): string[] {
	const principals = isRecord(config.principals) ? config.principals : {}
	return Object.entries(principals).flatMap(([id, entry]) => {
		const overrides = isRecord(entry) && isRecord(entry.security) ? entry.security : {}
		return Object.entries(overrides)
			.filter(([scheme]) => against.spec.schemes.has(scheme))
			.flatMap(([scheme, override]) => {
				const base = against.security[scheme] as Partial<Recipe> | undefined
				const effective = effectiveRecipe(base, override as Partial<Recipe>)
				return recipeProblems(`principals.${id}.security.${scheme}`, scheme, effective, against)
			})
	})
}

function originProblems(
	config: Raw,
	origins: Readonly<Record<string, SpecView>>,
	recipes: ReadonlySet<string>,
): string[] {
	const declared = Array.isArray(config.origins) ? (config.origins as Raw[]) : []
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

/** Every problem with a config's `security` and `principals`, against the primary document and each origin's. */
export function securityProblems(
	config: Raw,
	spec: SpecView,
	origins: Readonly<Record<string, SpecView>> = {},
): string[] {
	const security = isRecord(config.security) ? config.security : {}
	const hooks = isRecord(config.hooks) ? config.hooks : {}
	const against: Against = { hasHook: typeof hooks.resolveCredential === "function", security, spec }
	const shape =
		config.security === undefined || isRecord(config.security) ? [] : ["security must be a map of scheme → recipe"]
	return [
		...shape,
		...Object.entries(security).flatMap(([name, recipe]) => recipeProblems(`security.${name}`, name, recipe, against)),
		...overrideProblems(config, against),
		...principalProblems(config, new Set(spec.schemes.keys())),
		...removedProblems(config),
		...(spec.authFlows
			? ["the document's x-auth-flows tag is no longer read: declare a security.<scheme> recipe in config"]
			: []),
		...originProblems(config, origins, new Set(Object.keys(security))),
	].toSorted()
}
