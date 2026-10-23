import { isRaw, isRecord, type RawOf, type RawOfUnion } from "../../config/types/raw.ts"
import type {
	ExtraPlacement,
	LoginRecipe,
	MintRecipe,
	OAuth2Recipe,
	Recipe,
	StaticRecipe,
} from "../../config/types/security.ts"
import type { SecurityScheme } from "../../spec/security/schemes.ts"
import { capturedBy, unfilledIn } from "../placeholders.ts"

/*
 * Each recipe kind's own shape. A config written as .json or .mjs never meets the TypeScript types,
 * so this is the only thing standing between a typo and a crash at the first request.
 */

type RawRecipe = RawOfUnion<Recipe>
/* What a login and a refresh both run. */
type Chain = NonNullable<Recipe["refresh"]>
/** A login's revoke in its object form: the operation, and the body it sends. */
export type RevokeOperation = Exclude<LoginRecipe["revoke"], string | undefined>
type BasicPair = Exclude<StaticRecipe, string>

const isString = (value: unknown): value is string => typeof value === "string"
const stringList = (value: unknown): boolean => Array.isArray(value) && value.every(isString)
const article = (word: string): string => (/^[aeiou]/i.test(word) ? "an" : "a")

const LOCATIONS: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["header", "query", "cookie"])

const validExpiry = (value: unknown): boolean =>
	typeof value === "number"
		? value > 0
		: isRaw<Exclude<Recipe["expiresIn"], number | undefined>>(value) && typeof value.from === "string"

/** An extra placement oat can send: a known location, a name, and a template that holds the credential. */
export const validPlacement = (value: unknown): value is ExtraPlacement =>
	isRaw<ExtraPlacement>(value) &&
	LOCATIONS.has(value.in) &&
	typeof value.name === "string" &&
	(value.template === undefined || (typeof value.template === "string" && value.template.includes("{credential}")))

/** What is wrong with the options a recipe of any kind carries: its lifetime, held scopes and extra placements. */
export function optionProblems(path: string, recipe: RawRecipe): string[] {
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

/** `steps` and `from`: what a login and a refresh both run. */
function stepsShape(path: string, value: unknown): string[] {
	const raw: RawOf<Chain> = isRaw<Chain>(value) ? value : {}
	return [
		...(Array.isArray(raw.steps) && raw.steps.length > 0 ? [] : [`${path}.steps must be a non-empty list of steps`]),
		...(isString(raw.from) ? [] : [`${path}.from must be a JSON path string`]),
	]
}

const stepsOf = (value: unknown): unknown[] => (isRaw<Chain>(value) && Array.isArray(value.steps) ? value.steps : [])

/*
 * A `{name}` the login's steps read that no earlier step binds, or the refresh's that neither the
 * login saves nor an earlier refresh step binds (`credential` is the session's own value): it
 * would be sent as written. Where the document signs principals up, a session may be taken from the
 * signup's answer and refresh from what it carries, which only the run sees: the store refuses it then.
 */
function placeholderProblems(path: string, recipe: RawRecipe, signsUp: boolean): string[] {
	const login = stepsOf(recipe.login)
	const problems: string[] = []
	const loginGap = unfilledIn(login, [])
	if (loginGap !== undefined) {
		problems.push(
			`${path}.login.steps[${loginGap.step - 1}] reads {${loginGap.name}}, which no earlier login step binds`,
		)
	}
	const refreshGap = signsUp ? undefined : unfilledIn(stepsOf(recipe.refresh), [...capturedBy(login), "credential"])
	if (refreshGap !== undefined) {
		problems.push(
			`${path}.refresh.steps[${refreshGap.step - 1}] reads {${refreshGap.name}}, ` +
				"which neither the login saves nor an earlier refresh step binds",
		)
	}
	return problems
}

/* A claim binds the principal's tenant, or one of its scope parameters: nothing else is the principal's to bind. */
const CLAIM_TARGET = /^(?:tenant|scope\.[\w-]+)$/

/** `login.claims`: target → the claim name or JSON path in the answer that fills it. */
function claimsShape(path: string, login: unknown): string[] {
	if (!isRaw<LoginRecipe>(login) || login.claims === undefined) return []
	if (!isRecord(login.claims)) return [`${path}.claims must be a map of target → claim`]
	return Object.entries(login.claims).flatMap(([target, claim]) => {
		if (!CLAIM_TARGET.test(target)) {
			return [`${path}.claims.${target} binds nothing: a claim binds tenant or scope.<parameter>`]
		}
		return isString(claim) ? [] : [`${path}.claims.${target} must be a claim name or JSON path string`]
	})
}

/** `login.revoke`: the operation that revokes a session, for the dedicated sessions probes open. */
function revokeShape(path: string, login: unknown): string[] {
	if (!isRaw<LoginRecipe>(login) || login.revoke === undefined || isString(login.revoke)) return []
	if (isRaw<RevokeOperation>(login.revoke) && isString(login.revoke.operationId)) return []
	return [`${path}.revoke must be an operationId, or { operationId, body? }`]
}

function mintShape(path: string, mint: RawOf<MintRecipe>): string[] {
	return (["with", "operationId"] as const)
		.filter((field) => !isString(mint[field]))
		.map((field) => `${path}.mint.${field} must be a string`)
		.concat(isString(mint.from) ? [] : [`${path}.mint.from must be a JSON path string`])
}

function staticShape(path: string, value: unknown, scheme: SecurityScheme): string[] {
	if (scheme.kind === "basic") {
		const pair = isRaw<BasicPair>(value) && isString(value.username) && isString(value.password)
		return pair ? [] : [`${path}.static must be { username, password } for a basic scheme`]
	}
	return isString(value) ? [] : [`${path}.static must be a string for ${article(scheme.kind)} ${scheme.kind} scheme`]
}

function oauth2Shape(path: string, oauth2: RawOf<OAuth2Recipe>): string[] {
	const problems: string[] = []
	if (!isString(oauth2.clientId)) problems.push(`${path}.oauth2.clientId must be a string`)
	if (oauth2.scopes !== undefined && !stringList(oauth2.scopes)) {
		problems.push(`${path}.oauth2.scopes must be a list of scope names`)
	}
	if (oauth2.flow === "password") {
		for (const field of ["username", "password"] as const) {
			if (!isString(oauth2[field])) problems.push(`${path}.oauth2.${field} must be a string for the password flow`)
		}
	}
	return problems
}

function hookShape(path: string, hook: unknown, hasHook: boolean): string[] {
	if (hook !== true) return [`${path}.hook must be true`]
	return hasHook ? [] : [`${path}.hook needs hooks.resolveCredential in the config`]
}

const KINDS = ["login", "mint", "static", "hook", "oauth2"] as const

/** What is wrong with a recipe that names no kind, or more than one. */
export function kindProblems(path: string, recipe: RawRecipe): string[] {
	const present = KINDS.filter((kind) => recipe[kind] !== undefined)
	if (present.length === 1) return []
	if (present.length === 0) return [`${path} needs exactly one of ${KINDS.join(", ")}`]
	return [`${path} has ${present.join(" and ")}; keep exactly one`]
}
type Kind = (typeof KINDS)[number]

/* Why `holds` does not fit a kind whose credential's scopes come from elsewhere. */
const HOLDS_ELSEWHERE: Readonly<Record<string, string>> = {
	login: "holds is for a static or hook recipe",
	mint: "holds is not for a mint recipe: it holds the scopes its body asks for",
	oauth2: "holds is not for an oauth2 recipe: it holds the oauth2.scopes it asks for",
}

/** Options that describe one kind's credential, on a recipe of another kind. */
function fitProblems(path: string, recipe: RawRecipe): string[] {
	const kind = KINDS.find((name) => recipe[name] !== undefined) as Kind
	const problems: string[] = []
	if (recipe.refresh !== undefined && kind !== "login") problems.push(`${path}.refresh is for a login recipe only`)
	if (isRecord(recipe.expiresIn) && (kind === "static" || kind === "hook")) {
		problems.push(`${path}.expiresIn.from reads the answer that issued the credential; a ${kind} recipe has none`)
	}
	const elsewhere = HOLDS_ELSEWHERE[kind]
	if (stringList(recipe.holds) && elsewhere !== undefined) problems.push(`${path}.${elsewhere}`)
	return problems
}

/** What a recipe's shape is checked for: its scheme, whether a credential hook exists, and whether the document signs principals up. */
export interface ShapeFor {
	scheme: SecurityScheme
	hasHook: boolean
	signsUp: boolean
}

/** What is wrong with the shape of a recipe of exactly one kind, for its scheme. */
export function kindShapeProblems(path: string, recipe: RawRecipe, { hasHook, scheme, signsUp }: ShapeFor): string[] {
	return [
		...fitProblems(path, recipe),
		...(recipe.login === undefined ? [] : stepsShape(`${path}.login`, recipe.login)),
		...claimsShape(`${path}.login`, recipe.login),
		...revokeShape(`${path}.login`, recipe.login),
		...(recipe.refresh === undefined ? [] : stepsShape(`${path}.refresh`, recipe.refresh)),
		...placeholderProblems(path, recipe, signsUp),
		...(isRaw<MintRecipe>(recipe.mint) ? mintShape(path, recipe.mint) : []),
		...(recipe.static === undefined ? [] : staticShape(path, recipe.static, scheme)),
		...(isRaw<OAuth2Recipe>(recipe.oauth2) ? oauth2Shape(path, recipe.oauth2) : []),
		...(recipe.hook === undefined ? [] : hookShape(path, recipe.hook, hasHook)),
		...(recipe.format === undefined || (isString(recipe.format) && recipe.format.includes("{credential}"))
			? []
			: [`${path}.format must contain {credential}`]),
	]
}
