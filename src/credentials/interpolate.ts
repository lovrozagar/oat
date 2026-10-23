import type { CredentialPrincipal } from "../config/types/hooks.ts"
import { PRINCIPAL_PLACEHOLDER } from "../config/types/placeholder.ts"

/*
 * `{principal.<key>}` in a recipe's strings and step bodies is the principal's identity data, filled
 * before anything runs. `{principal.id}` falls back to the principal's id. Other `{name}` placeholders
 * are the step runner's flow scope, and stay as they are.
 */

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
	if (typeof value === "string") return value.replace(PRINCIPAL_PLACEHOLDER, (_, key: string) => textOf(principal, key))
	if (Array.isArray(value)) return value.map((item) => fill(principal, item))
	if (value === null || typeof value !== "object") return value
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(principal, item)]))
}

/**
 * Each identity value a `{principal.<key>}` in `value` fills, once, deep through arrays and plain
 * objects. The id `{principal.id}` falls back to is the principal's name, which every report prints,
 * so it is not one; a key the principal lacks is `fillPrincipal`'s to refuse.
 */
export function principalValues(principal: CredentialPrincipal, value: unknown): string[] {
	const found = new Set<string>()
	const walk = (item: unknown): void => {
		if (typeof item === "string") {
			for (const key of principalKeysIn(item)) {
				const text = scalarText(principal.identity[key])
				if (text !== undefined) found.add(text)
			}
		} else if (Array.isArray(item)) item.forEach(walk)
		else if (item !== null && typeof item === "object") Object.values(item).forEach(walk)
	}
	walk(value)
	return [...found]
}

/** The identity keys `text`'s `{principal.<key>}` placeholders read, in order. */
export function principalKeysIn(text: string): string[] {
	return [...text.matchAll(PRINCIPAL_PLACEHOLDER)].map(([, key]) => key as string)
}

/** The value with the credential wherever `{credential}` stands, deep through arrays and plain objects. */
export function fillCredential(value: unknown, credential: string): unknown {
	if (typeof value === "string") return value.replaceAll("{credential}", credential)
	if (Array.isArray(value)) return value.map((item) => fillCredential(item, credential))
	if (value === null || typeof value !== "object") return value
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillCredential(item, credential)]))
}

function textOf(principal: CredentialPrincipal, key: string): string {
	const text = scalarText(principal.identity[key] ?? (key === "id" ? principal.id : undefined))
	if (text === undefined) throw new MissingIdentityError(principal.id, key)
	return text
}

function scalarText(value: unknown): string | undefined {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value)
		: undefined
}
