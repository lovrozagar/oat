/*
 * The principals map, the `{principal.<key>}` placeholders recipes use, and the fields 0.25.0
 * removed. Each problem names the path and, for a removed field, what replaces it.
 */

type Raw = Record<string, unknown>

const isRecord = (value: unknown): value is Raw => value !== null && typeof value === "object" && !Array.isArray(value)

const REMOVED_ON_PRINCIPAL: Readonly<Record<string, string>> = {
	auth: "put the flow in security.<scheme>: { login: { steps, from } }",
	headers: "a fixed credential is security.<scheme>: { static: … }",
	roots: "give the principal its tenant and identity data instead",
}

const FIELD_CHECKS: ReadonlyArray<[string, (value: unknown) => boolean, string]> = [
	["fresh", (value) => typeof value === "boolean", "must be true or false"],
	["inviteAs", (value) => typeof value === "string", "must be a string"],
	["rank", (value) => Number.isSafeInteger(value), "must be an integer"],
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

function entryProblems(id: string, entry: Raw, schemes: ReadonlySet<string>, declared: string): string[] {
	const path = `principals.${id}`
	const problems: string[] = []
	for (const [field, why] of Object.entries(REMOVED_ON_PRINCIPAL)) {
		if (field in entry) problems.push(`${path}.${field} was removed in 0.25.0: ${why}`)
	}
	for (const [field, valid, need] of FIELD_CHECKS) {
		if (field in entry && !valid(entry[field])) problems.push(`${path}.${field} ${need}`)
	}
	const overrides = isRecord(entry.security) ? Object.keys(entry.security) : []
	for (const scheme of overrides.filter((name) => !schemes.has(name))) {
		problems.push(`${path}.security.${scheme} names no scheme in the document. The document declares: ${declared}`)
	}
	return problems
}

function placeholderProblems(id: string, entry: Raw, security: Raw): string[] {
	const overridden = isRecord(entry.security) ? entry.security : {}
	return Object.entries(security).flatMap(([scheme, recipe]) =>
		scheme in overridden
			? []
			: [...placeholders(recipe)]
					.filter((key) => !(key in entry))
					.map((key) => `principals.${id} has no "${key}", which security.${scheme} uses as {principal.${key}}`),
	)
}

/** What is wrong with `config.principals`, against the declared schemes and the recipes. */
export function principalProblems(config: Raw, schemes: ReadonlySet<string>): string[] {
	const principals = config.principals
	if (Array.isArray(principals)) {
		return ["principals is a map of id → identity data now: { alpha: { email: …, tenant: … } }"]
	}
	if (!isRecord(principals)) return ["principals must be a map of id → identity data"]
	const entries = Object.entries(principals)
	if (entries.length === 0) return ["principals declares no principal"]
	const declared = [...schemes].toSorted().join(", ")
	const security = isRecord(config.security) ? config.security : {}
	return entries.flatMap(([id, entry]) =>
		isRecord(entry)
			? [...entryProblems(id, entry, schemes, declared), ...placeholderProblems(id, entry, security)]
			: [`principals.${id} must be an object of identity data`],
	)
}

/** Top-level fields 0.25.0 removed, with their replacement. */
export function removedProblems(config: Raw): string[] {
	return "rootsFromFlow" in config
		? ["rootsFromFlow was removed in 0.25.0: bind token claims with security.<scheme>.login.claims"]
		: []
}
