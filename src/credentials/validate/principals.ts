/*
 * The principals map, the `{principal.<key>}` placeholders recipes use, and the fields 0.25.0
 * removed. Each problem names the path and, for a removed field, what replaces it.
 */

import { effectiveRecipe } from "../effective.ts"
import type { Recipe } from "../../config/types/security.ts"
import { requestSchema } from "../../spec/collection/request.ts"
import type { SpecModel } from "../../spec/graph/types.ts"
import type { OperationObject } from "../../spec/types.ts"

type Raw = Record<string, unknown>

const isRecord = (value: unknown): value is Raw => value !== null && typeof value === "object" && !Array.isArray(value)

/* What replaces each field 0.25.0 removed from a principal, said for the principal at `path`. */
const REMOVED_ON_PRINCIPAL: Readonly<Record<string, (path: string) => string>> = {
	auth: () => "put the flow in security.<scheme>: { login: { steps, from } }",
	headers: () => "a fixed credential is security.<scheme>: { static: … }",
	roots: (path) => `bind its parameters with ${path}.scope and its tenant with tenant`,
	rootsFromFlow: () => "bind token claims with security.<scheme>.login.claims",
}

const FIELD_CHECKS: ReadonlyArray<[string, (value: unknown) => boolean, string]> = [
	["created", (value) => typeof value === "boolean", "must be true or false"],
	["fresh", (value) => typeof value === "boolean", "must be true or false"],
	["inviteAs", (value) => typeof value === "string", "must be a string"],
	["rank", (value) => Number.isSafeInteger(value), "must be an integer"],
	["readOnly", (value) => value === true, "must be true, or left out"],
	["tenant", (value) => typeof value === "string", "must be a string"],
]

/** Every `{principal.<key>}` a value uses, wherever it is nested. */
export function placeholders(value: unknown): Set<string> {
	const found = new Set<string>()
	const visit = (node: unknown): void => {
		if (typeof node === "string")
			for (const [, key] of node.matchAll(/\{principal\.([\w-]+)\}/g)) found.add(String(key))
		else if (Array.isArray(node)) node.forEach(visit)
		else if (isRecord(node)) Object.values(node).forEach(visit)
	}
	visit(value)
	return found
}

/** `scope`: the path or query parameters bound for this principal, each to a string. */
function scopeProblems(path: string, scope: unknown): string[] {
	if (scope === undefined) return []
	if (!isRecord(scope)) return [`${path}.scope must be a map of parameter → value`]
	return Object.entries(scope)
		.filter(([, value]) => typeof value !== "string")
		.map(([name]) => `${path}.scope.${name} must be a string`)
}

function entryProblems(id: string, entry: Raw): string[] {
	const path = `principals.${id}`
	const problems: string[] = []
	for (const [field, why] of Object.entries(REMOVED_ON_PRINCIPAL)) {
		if (field in entry) problems.push(`${path}.${field} was removed in 0.25.0: ${why(path)}`)
	}
	problems.push(...scopeProblems(path, entry.scope))
	for (const [field, valid, need] of FIELD_CHECKS) {
		if (field in entry && !valid(entry[field])) problems.push(`${path}.${field} ${need}`)
	}
	return problems
}

/** What a document declares, said after a name it lacks: its scheme names, sorted, or that it has none. */
export function declaredSchemes(schemes: Iterable<string>): string {
	const names = [...schemes].toSorted()
	return names.length === 0 ? "The document declares no security scheme" : `The document declares: ${names.join(", ")}`
}

/* Overrides for a scheme the document does not declare. */
function overrideSchemeProblems(id: string, entry: Raw, schemes: ReadonlySet<string>): string[] {
	const overrides = isRecord(entry.security) ? Object.keys(entry.security) : []
	const declared = declaredSchemes(schemes)
	return overrides
		.filter((name) => !schemes.has(name))
		.map((scheme) => `principals.${id}.security.${scheme} names no scheme in the document. ${declared}`)
}

/** The document's `x-fresh-principal` operation, and the top-level properties its request body names. */
export interface FreshView {
	operationId: string
	properties: readonly string[]
}

/** The operation a fresh principal is signed up by, when the document marks one. */
export function freshView(model: Pick<SpecModel, "operations" | "rawOperations">): FreshView | undefined {
	const op = model.operations.find((candidate) => candidate.freshPrincipal)
	if (op === undefined) return undefined
	/* Every operation of a built model has its raw operation. */
	const schema = requestSchema(model.rawOperations.get(op.operationId) as OperationObject)
	return { operationId: op.operationId, properties: Object.keys(isRecord(schema?.properties) ? schema.properties : {}) }
}

/* Placeholders of the recipes this principal will use, by scheme, that its entry has no key for. */
function missingKeys(entry: Raw, security: Raw): Array<[scheme: string, key: string]> {
	const overrides = isRecord(entry.security) ? entry.security : {}
	const schemes = new Set([...Object.keys(security), ...Object.keys(overrides)])
	return [...schemes].flatMap((scheme) => {
		const recipe = effectiveRecipe(security[scheme] as Partial<Recipe>, overrides[scheme] as Partial<Recipe>)
		return [...placeholders(recipe)].filter((key) => !(key in entry)).map((key): [string, string] => [scheme, key])
	})
}

/*
 * Placeholders the recipes use that the principal's config data lacks. A fresh principal's identity
 * is its signup body too, which only the document says, so `freshProblems` checks it against that.
 */
function placeholderProblems(id: string, entry: Raw, security: Raw): string[] {
	if (entry.fresh === true) return []
	return missingKeys(entry, security).map(
		([scheme, key]) => `principals.${id} has no "${key}", which security.${scheme} uses as {principal.${key}}`,
	)
}

/* A fresh principal needs the document's signup, and each placeholder from its entry or that signup's body. */
function freshProblems(id: string, entry: Raw, against: { security: Raw; fresh: FreshView | undefined }): string[] {
	if (entry.fresh !== true) return []
	const { fresh } = against
	if (fresh === undefined) {
		return [`principals.${id} is fresh, but the document marks no x-fresh-principal operation to sign it up`]
	}
	return missingKeys(entry, against.security)
		.filter(([, key]) => !fresh.properties.includes(key))
		.map(
			([scheme, key]) =>
				`principals.${id} has no "${key}", and ${fresh.operationId}'s request body names no such property, ` +
				`which security.${scheme} uses as {principal.${key}}`,
		)
}

/* The principals' entries, when `config.principals` is a non-empty map; otherwise why it is not. */
function entriesOf(config: Raw): Array<[string, unknown]> | string {
	const principals = config.principals
	if (Array.isArray(principals))
		return "principals is a map of id → identity data now: { alpha: { email: …, tenant: … } }"
	if (!isRecord(principals)) return "principals must be a map of id → identity data"
	const entries = Object.entries(principals)
	return entries.length === 0 ? "principals declares no principal" : entries
}

/** What is wrong with `config.principals` that needs no document: its shape, removed fields and placeholders. */
export function principalMapProblems(config: Raw): string[] {
	const entries = entriesOf(config)
	if (typeof entries === "string") return [entries]
	const security = isRecord(config.security) ? config.security : {}
	return entries.flatMap(([id, entry]) =>
		isRecord(entry)
			? [...entryProblems(id, entry), ...placeholderProblems(id, entry, security)]
			: [`principals.${id} must be an object of identity data`],
	)
}

/**
 * What is wrong with `config.principals`, against the declared schemes, the recipes and the
 * document's signup (`fresh`, absent when it marks none).
 */
export function principalProblems(config: Raw, schemes: ReadonlySet<string>, fresh?: FreshView): string[] {
	/* Only a run needs principals, and configProblems asks for them there; doctor and plan read a config without. */
	if (config.principals === undefined) return []
	const entries = entriesOf(config)
	const security = isRecord(config.security) ? config.security : {}
	const against = { fresh, security }
	const documented =
		typeof entries === "string"
			? []
			: entries.flatMap(([id, entry]) =>
					isRecord(entry) ? [...overrideSchemeProblems(id, entry, schemes), ...freshProblems(id, entry, against)] : [],
				)
	return [...principalMapProblems(config), ...documented]
}

/* What replaces each top-level key 0.25.0 removed. */
const REMOVED_TOP_LEVEL: Readonly<Record<string, string>> = {
	roots: "bind parameters per principal with principals.<id>.scope",
	rootsFromFlow: "bind token claims with security.<scheme>.login.claims",
	"x-auth-flows": "declare a security.<scheme> recipe for each scheme the document declares",
}

/** The top-level config keys 0.25.0 removed. */
export const REMOVED_KEYS: readonly string[] = /* @__PURE__ */ Object.keys(REMOVED_TOP_LEVEL)

/** Top-level fields 0.25.0 removed, with their replacement. */
export function removedProblems(config: Raw): string[] {
	return Object.entries(REMOVED_TOP_LEVEL)
		.filter(([key]) => key in config)
		.map(([key, replacement]) => `${key} was removed in 0.25.0: ${replacement}`)
}
