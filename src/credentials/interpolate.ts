import type { CredentialPrincipal } from "../config/types/hooks.ts"

/*
 * `{principal.<key>}` in a recipe's strings and step bodies is the principal's identity data, filled
 * before anything runs. `{principal.id}` falls back to the principal's id. Other `{name}` placeholders
 * are the step runner's flow scope, and stay as they are.
 */

const PLACEHOLDER = /\{principal\.([A-Za-z0-9_]+)\}/g

/** A `{principal.<key>}` placeholder the principal has no text value for. */
export class MissingIdentityError extends Error {
	override name = "MissingIdentityError"
	constructor(
		readonly principal: string,
		readonly key: string,
	) {
		super(`principal "${principal}" has no text value for {principal.${key}}`)
	}
}

/** The value with every `{principal.<key>}` filled, deep through arrays and plain objects. */
export function fillPrincipal<T>(principal: CredentialPrincipal, value: T): T {
	return fill(principal, value) as T
}

function fill(principal: CredentialPrincipal, value: unknown): unknown {
	if (typeof value === "string") return value.replace(PLACEHOLDER, (_, key: string) => textOf(principal, key))
	if (Array.isArray(value)) return value.map((item) => fill(principal, item))
	if (value === null || typeof value !== "object") return value
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(principal, item)]))
}

function textOf(principal: CredentialPrincipal, key: string): string {
	const value = principal.identity[key] ?? (key === "id" ? principal.id : undefined)
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
	throw new MissingIdentityError(principal.id, key)
}
