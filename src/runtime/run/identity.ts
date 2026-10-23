/*
 * A principal's identity as the credential store holds it: its config data, a fresh signup's values
 * and what a login's `claims` bound. `tenant` and `scope` grade and place it; the rest is what
 * recipes interpolate as `{principal.<key>}`. A claim binds a parameter as a `scope.<param>` key,
 * which wins over the config's `scope`.
 */

const SCOPED = "scope."

/** A principal's identity, split into its tenant, its scope and the data recipes interpolate. */
export interface Bound {
	identity: Record<string, unknown>
	tenant?: string
	scope: Record<string, string>
}

/** The tenant, scope and identity data of what the store holds for a principal. */
export function boundOf(held: Readonly<Record<string, unknown>>): Bound {
	const identity: Record<string, unknown> = {}
	const scope: Record<string, string> = { ...strings(held["scope"]) }
	for (const [key, value] of Object.entries(held)) {
		if (key.startsWith(SCOPED)) {
			if (typeof value === "string") scope[key.slice(SCOPED.length)] = value
		} else if (key !== "scope" && key !== "tenant") identity[key] = value
	}
	return typeof held["tenant"] === "string" ? { identity, scope, tenant: held["tenant"] } : { identity, scope }
}

/* The string entries of a plain object; anything else binds none. */
function strings(value: unknown): Record<string, string> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {}
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	)
}
