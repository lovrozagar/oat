/**
 * A run's principals as it leaves them, for `principals.json`: who each is, its tenant, rank and
 * scope, and what it held, so a second config (a CDN host, a second document) can reuse them. No
 * credential value is ever written there; the next run acquires its own by the same recipes. Values
 * leave the run only for `--keep-credentials`, which writes them outside the output directory.
 * Identity secrets stay out too: a credential-named key (`password`, `apiKey`) or a value the run
 * holds as a secret is omitted, so a recipe that signs in with one reads it from the config, never the file.
 */

import { readFileSync } from "node:fs"
import type { PrincipalEntry, PrincipalsConfig } from "../config/types/security.ts"
import type { HeldCredential } from "../credentials/store.ts"
import { isSecretJsonKey } from "../security/credential-names.ts"
import type { Redactor } from "../security/redact.ts"
import type { RawOf } from "../config/types/raw.ts"

/** A credential a principal held when the run ended: which, and until when, never its value. */
export interface PersistedCredential {
	scheme: string
	scopes: string[]
	/** Epoch ms it lapses, or null when it never does as far as oat could tell. */
	expiresAt: number | null
}

export interface PersistedPrincipal {
	id: string
	/** The data recipes interpolate as `{principal.<key>}`: from config, a fresh signup or a login's claims. */
	identity: Record<string, unknown>
	tenant?: string
	rank: number
	scope: Record<string, string>
	inviteAs?: string
	credentials: PersistedCredential[]
	/** Why the run went on without it: what blocked its signup or login. Absent for a principal that signed in. */
	blocked?: string
}

export interface PersistedPrincipalsFile {
	principals: PersistedPrincipal[]
}

/** A credential value the run held, kept by `--keep-credentials` for later commands such as teardown replay. */
export interface KeptCredential extends PersistedCredential {
	principal: string
	value: string
}

/** What a principal is when the run ends. */
export interface SnapshotInput {
	id: string
	identity: Readonly<Record<string, unknown>>
	tenant?: string
	rank: number
	scope: Readonly<Record<string, string>>
	inviteAs?: string
	blocked?: string
}

/** What the run knows when it ends: the credentials it held, and the redactor that names its secrets. */
export interface SnapshotRun {
	held: readonly HeldCredential[]
	redactor: Pick<Redactor, "holdsSecret">
}

/* Keys a principal entry grades or authenticates by: never taken from persisted identity data. */
const RESERVED: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"fresh",
	"inviteAs",
	"rank",
	"scope",
	"security",
	"tenant",
])

/** The principal as `principals.json` keeps it, with the credentials `held` lists for it and no identity secret. */
export function snapshotPrincipal(input: SnapshotInput, { held, redactor }: SnapshotRun): PersistedPrincipal {
	const snap: PersistedPrincipal = {
		credentials: held
			.filter((entry) => entry.principal === input.id)
			.map(({ credential, scheme, scopes }) => ({ expiresAt: credential.expiresAt, scheme, scopes: [...scopes] })),
		id: input.id,
		identity: withoutSecrets(input.identity, redactor),
		rank: input.rank,
		scope: { ...input.scope },
	}
	if (input.tenant !== undefined) snap.tenant = input.tenant
	if (input.inviteAs !== undefined && !redactor.holdsSecret(input.inviteAs)) snap.inviteAs = input.inviteAs
	if (input.blocked !== undefined) snap.blocked = input.blocked
	return snap
}

/* `data` without a credential-named key or a value the run holds as a secret, at any depth. */
function withoutSecrets(data: Readonly<Record<string, unknown>>, redactor: SnapshotRun["redactor"]) {
	const kept: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(data)) {
		if (isSecretJsonKey(key)) continue
		if (typeof value === "string" && redactor.holdsSecret(value)) continue
		kept[key] = isObject(value) ? withoutSecrets(value, redactor) : value
	}
	return kept
}

/** Every value `held` lists, for `--keep-credentials`. */
export function keptCredentials(held: readonly HeldCredential[]): KeptCredential[] {
	return held.map(({ credential, principal, scheme, scopes }) => ({
		expiresAt: credential.expiresAt,
		principal,
		scheme,
		scopes: [...scopes],
		value: credential.value,
	}))
}

/** The principal entries of a parsed file: `{ principals: [...] }` or a bare array. */
function listOf(parsed: unknown): unknown[] | null {
	if (Array.isArray(parsed)) return parsed
	if (parsed === null || typeof parsed !== "object") return null
	const { principals } = parsed as RawOf<PersistedPrincipalsFile>
	return Array.isArray(principals) ? principals : null
}

/** One entry as an id and a config principal, or undefined when it has no id to go by. */
function entryOf(item: unknown): [string, PrincipalEntry] | undefined {
	if (item === null || typeof item !== "object") return undefined
	const rec = item as RawOf<PersistedPrincipal>
	if (typeof rec.id !== "string" || rec.id === "") return undefined
	const identity = isObject(rec.identity) ? rec.identity : {}
	const entry: PrincipalEntry = {
		...Object.fromEntries(Object.entries(identity).filter(([key]) => !RESERVED.has(key))),
		scope: stringMap(rec.scope),
	}
	if (typeof rec.tenant === "string") entry.tenant = rec.tenant
	if (typeof rec.rank === "number") entry.rank = rec.rank
	if (typeof rec.inviteAs === "string") entry.inviteAs = rec.inviteAs
	return [rec.id, entry]
}

/** `principals.json` read back into the config's principals map. */
export function parsePersistedPrincipals(raw: string, source = "principals.json"): PrincipalsConfig {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw) as unknown
	} catch (error) {
		throw new Error(`oat: ${source} is not valid JSON: ${String(error)}`, { cause: error })
	}
	const list = listOf(parsed)
	if (list === null) {
		throw new Error(`oat: ${source} must be { principals: [...] } or an array of principals`)
	}
	const entries = list.map(entryOf).filter((entry) => entry !== undefined)
	if (entries.length === 0) {
		throw new Error(`oat: ${source} contains no usable principals`)
	}
	return Object.fromEntries(entries)
}

/**
 * Synchronous so a config file can call it at module load. The file never holds an identity secret,
 * so a principal that signs in with one takes it from the config: spread the config's own entry over
 * the persisted one, `{ ...persisted.alpha, ...principals.alpha }`.
 */
export function loadPersistedPrincipals(path: string): PrincipalsConfig {
	let raw: string
	try {
		raw = readFileSync(path, "utf8")
	} catch (error) {
		throw new Error(`oat: cannot read persisted principals from ${path}: ${String(error)}`, { cause: error })
	}
	return parsePersistedPrincipals(raw, path)
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The string entries of a plain object; anything else holds none. */
function stringMap(value: unknown): Record<string, string> {
	if (!isObject(value)) return {}
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	)
}
