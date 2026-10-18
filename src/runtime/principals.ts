/**
 * Snapshot a run's principals so a second config (a CDN host, a second document) can reuse
 * the credentials the first run already acquired — without oat inventing a merged spec.
 */

import { readFileSync } from "node:fs"
import type { Principal } from "../config/types/principals.ts"

export interface PersistedPrincipal {
	id: string
	headers: Record<string, string>
	roots: Record<string, string>
	role?: string
	rank?: number
	inviteAs?: string
}

export interface PersistedPrincipalsFile {
	principals: PersistedPrincipal[]
}

export function snapshotPrincipal(input: {
	id: string
	headers: () => Record<string, string>
	roots: Record<string, string>
	role?: string
	rank?: number
	inviteAs?: string
}): PersistedPrincipal {
	const snap: PersistedPrincipal = {
		headers: { ...input.headers() },
		id: input.id,
		roots: { ...input.roots },
	}
	if (input.role !== undefined) snap.role = input.role
	if (input.rank !== undefined) snap.rank = input.rank
	if (input.inviteAs !== undefined) snap.inviteAs = input.inviteAs
	return snap
}

export function persistedToPrincipal(snap: PersistedPrincipal): Principal {
	const principal: Principal = {
		headers: { ...snap.headers },
		id: snap.id,
		roots: { ...snap.roots },
	}
	if (snap.role !== undefined) principal.role = snap.role
	if (snap.rank !== undefined) principal.rank = snap.rank
	if (snap.inviteAs !== undefined) principal.inviteAs = snap.inviteAs
	return principal
}

/** The principal entries of a parsed file: `{ principals: [...] }` or a bare array. */
function listOf(parsed: unknown): unknown[] | null {
	if (Array.isArray(parsed)) return parsed
	if (parsed === null || typeof parsed !== "object") return null
	const { principals } = parsed as PersistedPrincipalsFile
	return Array.isArray(principals) ? principals : null
}

/** One entry as a principal, or undefined when it has no id to go by. */
function principalOf(item: unknown): Principal | undefined {
	if (item === null || typeof item !== "object") return undefined
	const rec = item as Record<string, unknown>
	if (typeof rec.id !== "string" || rec.id === "") return undefined
	return persistedToPrincipal({
		headers: stringMap(rec.headers),
		id: rec.id,
		roots: stringMap(rec.roots),
		...(typeof rec.role === "string" ? { role: rec.role } : {}),
		...(typeof rec.rank === "number" ? { rank: rec.rank } : {}),
		...(typeof rec.inviteAs === "string" ? { inviteAs: rec.inviteAs } : {}),
	})
}

export function parsePersistedPrincipals(raw: string, source = "principals.json"): Principal[] {
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
	const principals = list.map(principalOf).filter((principal) => principal !== undefined)
	if (principals.length === 0) {
		throw new Error(`oat: ${source} contains no usable principals`)
	}
	return principals
}

/** Synchronous so a config file can call it at module load. */
export function loadPersistedPrincipals(path: string): [Principal, ...Principal[]] {
	let raw: string
	try {
		raw = readFileSync(path, "utf8")
	} catch (error) {
		throw new Error(`oat: cannot read persisted principals from ${path}: ${String(error)}`, { cause: error })
	}
	const principals = parsePersistedPrincipals(raw, path)
	return principals as [Principal, ...Principal[]]
}

/** The string entries of a plain object; anything else holds none. */
function stringMap(value: unknown): Record<string, string> {
	const out: Record<string, string> = {}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return out
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") out[key] = item
	}
	return out
}
