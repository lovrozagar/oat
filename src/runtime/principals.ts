/**
 * Snapshot a run's principals so a second config (a CDN host, a second document) can reuse
 * the credentials the first run already acquired — without oat inventing a merged spec.
 */

import { readFileSync } from "node:fs"
import type { Principal } from "../config/define-config.ts"

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

export function parsePersistedPrincipals(raw: string, source = "principals.json"): Principal[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw) as unknown
	} catch (error) {
		throw new Error(`oat: ${source} is not valid JSON: ${String(error)}`)
	}
	const list = Array.isArray(parsed)
		? parsed
		: parsed !== null && typeof parsed === "object" && Array.isArray((parsed as PersistedPrincipalsFile).principals)
			? (parsed as PersistedPrincipalsFile).principals
			: null
	if (list === null) {
		throw new Error(`oat: ${source} must be { principals: [...] } or an array of principals`)
	}
	const principals: Principal[] = []
	for (const item of list) {
		if (item === null || typeof item !== "object") continue
		const rec = item as Record<string, unknown>
		if (typeof rec.id !== "string" || rec.id === "") continue
		const headers =
			rec.headers !== null && typeof rec.headers === "object" && !Array.isArray(rec.headers)
				? stringRecord(rec.headers as Record<string, unknown>)
				: {}
		const roots =
			rec.roots !== null && typeof rec.roots === "object" && !Array.isArray(rec.roots)
				? stringRecord(rec.roots as Record<string, unknown>)
				: {}
		principals.push(
			persistedToPrincipal({
				headers,
				id: rec.id,
				roots,
				...(typeof rec.role === "string" ? { role: rec.role } : {}),
				...(typeof rec.rank === "number" ? { rank: rec.rank } : {}),
				...(typeof rec.inviteAs === "string" ? { inviteAs: rec.inviteAs } : {}),
			}),
		)
	}
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
		throw new Error(`oat: cannot read persisted principals from ${path}: ${String(error)}`)
	}
	const principals = parsePersistedPrincipals(raw, path)
	return principals as [Principal, ...Principal[]]
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") out[key] = item
	}
	return out
}
