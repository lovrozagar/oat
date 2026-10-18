/**
 * The reference on each engine: in memory, SQLite (`node:sqlite`), Cloudflare D1 over HTTP, and a
 * reachable Postgres. Every store is imported lazily — a static import would load one engine's
 * driver for all of them, and an optional runtime such as `node:sqlite` would take down paths that
 * never touch it.
 */

import { createReference, type Reference, type StoreFactory } from "./reference.ts"
import { createReferenceServer, type ReferenceServer } from "./server.ts"
import type { ReferenceOptions } from "./state.ts"

/** In memory: no dependencies, no flags, nothing to have running. */
export const memoryStore: StoreFactory = async () => {
	const { MemoryStore } = await import("../stores/memory.ts")
	return new MemoryStore()
}

/** SQLite, in process via `node:sqlite`. */
export const sqliteStore: StoreFactory = async (defects, entities) => {
	const { SqlStore } = await import("../stores/sqlite.ts")
	const { nodeSqliteDriver } = await import("../stores/sqlite-driver.ts")
	return SqlStore.create(defects, await nodeSqliteDriver(), "", entities)
}

/** Postgres: needs a reachable server, not just the driver. */
export const postgresStore: StoreFactory = async (defects, entities) => {
	const { PgStore } = await import("../stores/postgres.ts")
	return PgStore.create(defects, entities)
}

export interface D1Credentials {
	accountId?: string
	databaseId?: string
	apiToken?: string
}

/**
 * Cloudflare D1 — the same SQL over the network, against someone else's build.
 *
 * Credentials come from the environment rather than config so a token never reaches a file that
 * could be committed. Tables are prefixed per run and dropped on close, because D1 persists: two
 * runs sharing one database would otherwise contaminate each other's results.
 */
export function d1Store(credentials: D1Credentials = {}): StoreFactory {
	const accountId = credentials.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID
	const databaseId = credentials.databaseId ?? process.env.CLOUDFLARE_D1_DATABASE_ID
	const apiToken = credentials.apiToken ?? process.env.CLOUDFLARE_API_TOKEN
	const missing = [
		accountId === undefined ? "CLOUDFLARE_ACCOUNT_ID" : null,
		databaseId === undefined ? "CLOUDFLARE_D1_DATABASE_ID" : null,
		apiToken === undefined ? "CLOUDFLARE_API_TOKEN" : null,
	].filter((name): name is string => name !== null)
	if (missing.length > 0) throw new Error(`D1 backend needs ${missing.join(", ")} in the environment`)
	const prefix = `oat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_`
	return async (defects, entities) => {
		const { SqlStore } = await import("../stores/sqlite.ts")
		const { d1Driver } = await import("../stores/sqlite-driver.ts")
		const driver = d1Driver({
			accountId: accountId as string,
			apiToken: apiToken as string,
			databaseId: databaseId as string,
		})
		return SqlStore.create(defects, driver, prefix, entities)
	}
}

export function createMemoryServer(options: ReferenceOptions = {}): Promise<ReferenceServer> {
	return createReferenceServer(options, memoryStore)
}

export function createSqliteServer(options: ReferenceOptions = {}): Promise<ReferenceServer> {
	return createReferenceServer(options, sqliteStore)
}

export function createPostgresServer(options: ReferenceOptions = {}): Promise<ReferenceServer> {
	return createReferenceServer(options, postgresStore)
}

export async function createD1Server(options: ReferenceOptions & D1Credentials = {}): Promise<ReferenceServer> {
	return createReferenceServer(options, d1Store(options))
}

/** The in-memory reference in process: what a unit test or an in-process conformance task talks to. */
export function createMemoryReference(options: ReferenceOptions = {}): Promise<Reference> {
	return createReference(options, memoryStore)
}
