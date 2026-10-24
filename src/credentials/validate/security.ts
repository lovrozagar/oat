import { isRaw, isRawUnion, isRecord, type RawOf } from "../../config/types/raw.ts"
import type { OatConfig, OriginSpec } from "../../config/types/config.ts"
import type { Hooks } from "../../config/types/hooks.ts"
import type { LoginRecipe, MintRecipe, OAuth2Recipe, PrincipalEntry, Recipe } from "../../config/types/security.ts"
import { nearest } from "../../errors/suggest.ts"
import { UsageError } from "../../errors/usage-error.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import { placementOf } from "../../spec/security/placement.ts"
import type { ResolvedSecurity } from "../../spec/security/requirements.ts"
import type { SecurityScheme } from "../../spec/security/schemes.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { effectiveRecipe } from "../effective.ts"
import { declaredSchemes, type FreshView, freshView, principalProblems, removedProblems } from "./principals.ts"
import { documentProblems } from "./document.ts"
import {
	kindProblems,
	kindShapeProblems,
	optionProblems,
	type RevokeOperation,
	validPlacement,
} from "./recipe-shape.ts"

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
	/** The operation that signs a fresh principal up; absent when the document marks none. */
	fresh?: FreshView
}

/** The parts of a document's model validation reads. */
export type ModelView = Pick<SpecModel, "operations" | "rawOperations" | "schemes">

/** What validation reads from a document: its model, whether it still has `x-auth-flows`, and its signup. */
export function specView(model: ModelView, doc: OpenApiDocument): SpecView {
	const fresh = freshView(model)
	const view = { authFlows: "x-auth-flows" in doc, operations: model.operations, schemes: model.schemes }
	return fresh === undefined ? view : { ...view, fresh }
}

type Config = RawOf<OatConfig>

function oauth2Problems(path: string, oauth2: RawOf<OAuth2Recipe>, scheme: SecurityScheme): string[] {
	if (scheme.kind !== "oauth2") return [`${path}.oauth2 needs an oauth2 scheme; ${scheme.name} is ${scheme.kind}`]
	const flow = scheme.flows[oauth2.flow as keyof typeof scheme.flows]
	return flow?.tokenUrl === undefined
		? [`${path}.oauth2.flow "${String(oauth2.flow)}" is not a flow scheme ${scheme.name} declares with a tokenUrl`]
		: []
}

/** The chain of `mint.with` from `start`, ending where it leaves the mints or returns to `start`. */
function mintChain(start: string, security: Record<string, unknown>): string[] {
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
	security: Record<string, unknown>
	spec: SpecView
	hasHook: boolean
}

const names = (spec: SpecView, operationId: string): boolean =>
	spec.operations.some((op) => op.operationId === operationId)
/* A declared revoke, a mint's or a login's (alone, or `{ operationId, body }`), names an operation of the document. */
function revokeProblems(spec: SpecView, path: string, revoke: unknown): string[] {
	const id = isRaw<RevokeOperation>(revoke) ? revoke.operationId : revoke
	return typeof id === "string" && !names(spec, id) ? [`${path}.revoke "${id}" names no operation`] : []
}

/* References a mint makes, once its fields are strings: the shape check reports them otherwise. */
function mintProblems(ctx: Against, path: string, name: string, mint: RawOf<MintRecipe>): string[] {
	const { security, spec } = ctx
	const problems: string[] = []
	if (typeof mint.with === "string" && !isRecord(security[mint.with])) {
		problems.push(`${path}.mint.with names "${mint.with}", which has no recipe`)
	} else if (typeof mint.with === "string") {
		const chain = mintChain(name, security)
		if (chain.at(-1) === name) problems.push(`${path}.mint.with forms a loop: ${chain.join(" → ")}`)
	}
	problems.push(...revokeProblems(spec, `${path}.mint`, mint.revoke))
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

const NOT_A_MAP = "security must be a map of scheme → recipe"

/** What is wrong with `config.security` that needs no document: its shape, and each recipe's kind and options. */
export function securityMapProblems(config: Config): string[] {
	if (config.security === undefined) return []
	if (!isRecord(config.security)) return [NOT_A_MAP]
	return Object.entries(config.security).flatMap(([name, recipe]) => {
		const path = `security.${name}`
		if (!isRawUnion<Recipe>(recipe)) return [`${path} must be a recipe object`]
		const kind = kindProblems(path, recipe)
		return kind.length > 0 ? kind : optionProblems(path, recipe)
	})
}

function recipeProblems(ctx: Against, path: string, name: string, recipe: unknown): string[] {
	const { spec } = ctx
	const scheme = spec.schemes.get(name)
	if (scheme === undefined) {
		const close = nearest(name, spec.schemes.keys())[0]
		const hint = close === undefined ? "" : ` Did you mean "${close}"?`
		return [`${path} names no scheme in the document.${hint} ${declaredSchemes(spec.schemes.keys())}`]
	}
	if (scheme.kind === "unsupported") return [`${path}: ${scheme.unsupported}`]
	if (!isRawUnion<Recipe>(recipe)) return [`${path} must be a recipe object`]
	const kind = kindProblems(path, recipe)
	if (kind.length > 0) return kind
	return [
		...optionProblems(path, recipe),
		...kindShapeProblems(path, recipe, { hasHook: ctx.hasHook, scheme, signsUp: spec.fresh !== undefined }),
		...(isRaw<OAuth2Recipe>(recipe.oauth2) ? oauth2Problems(path, recipe.oauth2, scheme) : []),
		...(isRaw<MintRecipe>(recipe.mint) ? mintProblems(ctx, path, name, recipe.mint) : []),
		...(isRaw<LoginRecipe>(recipe.login) ? revokeProblems(ctx.spec, `${path}.login`, recipe.login.revoke) : []),
	]
}

/* Each principal's override, checked as the recipe that principal will actually use. */
function overrideProblems(config: Config, against: Against): string[] {
	const principals = isRecord(config.principals) ? config.principals : {}
	return Object.entries(principals).flatMap(([id, entry]) => {
		const overrides = isRaw<PrincipalEntry>(entry) && isRecord(entry.security) ? entry.security : {}
		return Object.entries(overrides)
			.filter(([scheme]) => against.spec.schemes.has(scheme))
			.flatMap(([scheme, override]) => {
				const base = against.security[scheme] as Partial<Recipe> | undefined
				const effective = effectiveRecipe(base, override as Partial<Recipe>)
				return recipeProblems(against, `principals.${id}.security.${scheme}`, scheme, effective)
			})
	})
}

function originProblems(
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

/** A header a credential is placed in: whose place it is, and what to do instead of sending it from globalHeaders. */
interface HeaderPlace {
	name: string
	owner: string
	fix: string
}

/* Every header a declared scheme, an origin's scheme or a recipe's extra placement puts a credential in. */
function headerPlaces(
	security: Record<string, unknown>,
	spec: SpecView,
	origins: Readonly<Record<string, SpecView>>,
): HeaderPlace[] {
	const ofSchemes = (view: SpecView, owner: (scheme: string) => string, fix: (scheme: string) => string) =>
		[...view.schemes].flatMap(([scheme, declared]) => {
			const place = placementOf(declared)
			return place?.in === "header" ? [{ fix: fix(scheme), name: place.name, owner: owner(scheme) }] : []
		})
	const extra = Object.entries(security).flatMap(([scheme, recipe]) => {
		const placements: unknown[] =
			isRawUnion<Recipe>(recipe) && Array.isArray(recipe.placements) ? recipe.placements : []
		return placements.flatMap((placement, index) =>
			validPlacement(placement) && placement.in === "header"
				? [{ fix: "remove it", name: placement.name, owner: `security.${scheme}.placements[${index}]` }]
				: [],
		)
	})
	return [
		...ofSchemes(
			spec,
			(scheme) => `scheme "${scheme}"`,
			(scheme) => `remove it and declare security.${scheme}`,
		),
		...Object.entries(origins).flatMap(([id, view]) =>
			ofSchemes(
				view,
				(scheme) => `origins.${id} scheme "${scheme}"`,
				() => "remove it and map the scheme with origins[].security",
			),
		),
		...extra,
	]
}

/* globalHeaders never carry a credential: an entry in a place a credential goes would collide with it. */
function globalHeaderProblems(config: Config, places: readonly HeaderPlace[]): string[] {
	const headers = isRecord(config.globalHeaders) ? Object.keys(config.globalHeaders) : []
	return headers.flatMap((header) =>
		places
			.filter((place) => place.name.toLowerCase() === header.toLowerCase())
			.map((place) => `globalHeaders.${header} is where ${place.owner} places its credential; ${place.fix}`),
	)
}

/** Every problem with a config's `security` and `principals`, against the primary document and each origin's. */
export function securityProblems(
	config: Config,
	spec: SpecView,
	origins: Readonly<Record<string, SpecView>> = {},
): string[] {
	const security = isRecord(config.security) ? config.security : {}
	const hooks: RawOf<Hooks> = isRaw<Hooks>(config.hooks) ? config.hooks : {}
	const against: Against = { hasHook: typeof hooks.resolveCredential === "function", security, spec }
	const shape = config.security === undefined || isRecord(config.security) ? [] : [NOT_A_MAP]
	return [
		...shape,
		...Object.entries(security).flatMap(([name, recipe]) => recipeProblems(against, `security.${name}`, name, recipe)),
		...overrideProblems(config, against),
		...principalProblems(config, new Set(spec.schemes.keys()), spec.fresh),
		...removedProblems(config),
		...documentProblems(config, spec, origins),
		...originProblems(config, origins, new Set(Object.keys(security))),
		...globalHeaderProblems(config, headerPlaces(security, spec, origins)),
	].toSorted()
}

/** A document and its model: what a run, `doctor` and `plan` check a config against. */
export interface ModeledDocument {
	doc: OpenApiDocument
	model: ModelView
}

/** Throws a UsageError naming every `securityProblems` problem against the primary document and each origin's. */
export function assertSecurity(
	config: Config,
	primary: ModeledDocument,
	origins: ReadonlyMap<string, ModeledDocument> = new Map(),
): void {
	const views = Object.fromEntries([...origins].map(([id, origin]) => [id, specView(origin.model, origin.doc)]))
	const problems = securityProblems(config, specView(primary.model, primary.doc), views)
	if (problems.length > 0) {
		throw new UsageError(`the config's credentials do not fit the document:\n  ${problems.join("\n  ")}`)
	}
}
