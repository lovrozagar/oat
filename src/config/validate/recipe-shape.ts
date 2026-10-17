import type { SecurityScheme } from "../../spec/security/schemes.ts"

/*
 * Each recipe kind's own shape. A config written as .json or .mjs never meets the TypeScript types,
 * so this is the only thing standing between a typo and a crash at the first request.
 */

type Raw = Record<string, unknown>

const isRecord = (value: unknown): value is Raw => value !== null && typeof value === "object" && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === "string"
const stringList = (value: unknown): boolean => Array.isArray(value) && value.every(isString)
const article = (word: string): string => (/^[aeiou]/i.test(word) ? "an" : "a")

/** `steps` and `from`: what a login and a refresh both run. */
function stepsShape(path: string, value: unknown): string[] {
	const raw = isRecord(value) ? value : {}
	return [
		...(Array.isArray(raw.steps) && raw.steps.length > 0 ? [] : [`${path}.steps must be a non-empty list of steps`]),
		...(isString(raw.from) ? [] : [`${path}.from must be a JSON path string`]),
	]
}

function mintShape(path: string, mint: Raw): string[] {
	return ["with", "operationId"]
		.filter((field) => !isString(mint[field]))
		.map((field) => `${path}.mint.${field} must be a string`)
		.concat(isString(mint.from) ? [] : [`${path}.mint.from must be a JSON path string`])
}

function staticShape(path: string, value: unknown, scheme: SecurityScheme): string[] {
	if (scheme.kind === "basic") {
		const pair = isRecord(value) && isString(value.username) && isString(value.password)
		return pair ? [] : [`${path}.static must be { username, password } for a basic scheme`]
	}
	return isString(value) ? [] : [`${path}.static must be a string for ${article(scheme.kind)} ${scheme.kind} scheme`]
}

function oauth2Shape(path: string, oauth2: Raw): string[] {
	const problems: string[] = []
	if (!isString(oauth2.clientId)) problems.push(`${path}.oauth2.clientId must be a string`)
	if (oauth2.scopes !== undefined && !stringList(oauth2.scopes)) {
		problems.push(`${path}.oauth2.scopes must be a list of scope names`)
	}
	if (oauth2.flow === "password") {
		for (const field of ["username", "password"]) {
			if (!isString(oauth2[field])) problems.push(`${path}.oauth2.${field} must be a string for the password flow`)
		}
	}
	return problems
}

function hookShape(path: string, hook: unknown, hasHook: boolean): string[] {
	if (hook !== true) return [`${path}.hook must be true`]
	return hasHook ? [] : [`${path}.hook needs hooks.resolveCredential in the config`]
}

/** What is wrong with the shape of a recipe of exactly one kind, for its scheme. */
export function kindShapeProblems(path: string, recipe: Raw, scheme: SecurityScheme, hasHook: boolean): string[] {
	return [
		...(recipe.login === undefined ? [] : stepsShape(`${path}.login`, recipe.login)),
		...(recipe.refresh === undefined ? [] : stepsShape(`${path}.refresh`, recipe.refresh)),
		...(isRecord(recipe.mint) ? mintShape(path, recipe.mint) : []),
		...(recipe.static === undefined ? [] : staticShape(path, recipe.static, scheme)),
		...(isRecord(recipe.oauth2) ? oauth2Shape(path, recipe.oauth2) : []),
		...(recipe.hook === undefined ? [] : hookShape(path, recipe.hook, hasHook)),
		...(recipe.format === undefined || (isString(recipe.format) && recipe.format.includes("{credential}"))
			? []
			: [`${path}.format must contain {credential}`]),
	]
}
