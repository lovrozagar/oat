import { afterEach, describe, expect, it, vi } from "vitest"
import { DefectSet } from "../defects.ts"
import { ENTITIES } from "../model.ts"
import { MemoryStore } from "../stores/memory.ts"
import { SqlStore } from "../stores/sqlite.ts"
import { type FakeServer, serve } from "./__fixtures__/fake-http.ts"
import {
	createD1Server,
	createMemoryReference,
	createMemoryServer,
	createPostgresServer,
	createSqliteServer,
	d1Store,
	memoryStore,
	postgresStore,
	sqliteStore,
} from "./engines.ts"

/* Every server the engines make binds nothing, and Postgres is a memory store standing in for one. */
const fakes = vi.hoisted(() => ({ pg: [] as unknown[][], servers: [] as FakeServer[] }))

vi.mock("node:http", async () => {
	const { fakeCreate } = await import("./__fixtures__/fake-http.ts")
	return { createServer: fakeCreate(fakes.servers) }
})

vi.mock("../stores/postgres.ts", async () => {
	const { MemoryStore: Stand } = await import("../stores/memory.ts")
	return {
		PgStore: {
			create: async (...args: unknown[]) => {
				fakes.pg.push(args)
				return new Stand()
			},
		},
	}
})

const CREDENTIALS = { accountId: "acct", apiToken: "secret", databaseId: "db" }
const ENV = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN"] as const
const D1_QUERY = "https://api.cloudflare.com/client/v4/accounts/env-acct/d1/database/env-db/query"

interface D1Call {
	url: string
	sql: string
	authorization: string
}

/* D1's query API, answering every statement with success and no rows. */
function stubD1(): D1Call[] {
	const calls: D1Call[] = []
	const answer = async (url: string, init: RequestInit) => {
		const { sql } = JSON.parse(String(init.body)) as { sql: string }
		calls.push({ authorization: (init.headers as Record<string, string>).authorization ?? "", sql, url })
		return Response.json({ result: [{ results: [] }], success: true })
	}
	vi.stubGlobal("fetch", answer)
	return calls
}

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	fakes.servers.length = 0
	fakes.pg.length = 0
})

describe("memoryStore and sqliteStore", () => {
	it("build a store for the entities, in memory and in node:sqlite", async () => {
		expect(await memoryStore(new DefectSet(), ENTITIES)).toBeInstanceOf(MemoryStore)
		const sqlite = await sqliteStore(new DefectSet(), ENTITIES)
		expect(sqlite).toBeInstanceOf(SqlStore)
		await sqlite.close()
	})
})

describe("postgresStore", () => {
	it("hands the defects and entities to the Postgres store", async () => {
		const defects = new DefectSet(["FILTER_IGNORED"])
		expect(await postgresStore(defects, ENTITIES)).toBeInstanceOf(MemoryStore)
		expect(fakes.pg).toEqual([[defects, ENTITIES]])
	})
})

describe("d1Store", () => {
	it("names every credential the environment lacks", () => {
		for (const name of ENV) vi.stubEnv(name, undefined)
		expect(() => d1Store()).toThrow(
			"D1 backend needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN in the environment",
		)
		expect(() => d1Store({ accountId: "a" })).toThrow(
			"D1 backend needs CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN",
		)
	})

	it("reads the credentials from the environment, and prefixes this run's tables", async () => {
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "env-acct")
		vi.stubEnv("CLOUDFLARE_D1_DATABASE_ID", "env-db")
		vi.stubEnv("CLOUDFLARE_API_TOKEN", "env-token")
		const calls = stubD1()
		const store = await d1Store()(new DefectSet(), ENTITIES)
		expect(store).toBeInstanceOf(SqlStore)
		expect(calls[0]?.url).toBe(D1_QUERY)
		expect(calls[0]?.authorization).toBe("Bearer env-token")
		expect(calls[0]?.sql).toMatch(/oat_[a-z0-9]+_[a-z0-9]{1,6}_table/)
	})

	it("prefers credentials it is given, and gives each run its own prefix", async () => {
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "env-acct")
		const calls = stubD1()
		await d1Store(CREDENTIALS)(new DefectSet(), ENTITIES)
		await d1Store(CREDENTIALS)(new DefectSet(), ENTITIES)
		expect(calls[0]?.url).toContain("/accounts/acct/d1/database/db/")
		const prefixes = calls.map((call) => /oat_[a-z0-9]+_[a-z0-9]+_/.exec(call.sql)?.[0])
		expect(prefixes[0]).not.toBe(prefixes[1])
	})
})

describe("the servers", () => {
	it("serve the reference on each engine, behind Node's server", async () => {
		const d1 = stubD1()
		const servers = [
			await createMemoryServer(),
			await createSqliteServer({ shape: "path-prefix" }),
			await createPostgresServer(),
			await createD1Server({ ...CREDENTIALS, dialect: "classic" }),
		]
		expect(servers.map((server) => server.url)).toEqual([
			"http://127.0.0.1:4321",
			"http://127.0.0.1:4321/api",
			"http://127.0.0.1:4321",
			"http://127.0.0.1:4321",
		])
		expect(fakes.servers.map((server) => server.bound)).toEqual(
			Array.from({ length: 4 }, () => ({ host: "127.0.0.1", port: 0 })),
		)
		const sqlite = fakes.servers[1] as FakeServer
		const listed = await serve(sqlite.listener, {
			headers: { authorization: "Bearer tok_alpha" },
			url: "/api/v1/projects/proj_alpha/tables",
		})
		expect(JSON.parse(listed.body)).toMatchObject({ count: 0, tables: [] })
		expect(fakes.pg).toHaveLength(1)
		expect(d1.length).toBeGreaterThan(0)
		for (const server of servers) await server.close()
	})

	it("default to no options", async () => {
		const memory = await createMemoryServer()
		expect(memory.defects.list()).toEqual([])
		await memory.close()
	})
})

describe("createMemoryReference", () => {
	it("is the in-memory reference in process", async () => {
		expect((await createMemoryReference({ shape: "path-prefix" })).url).toBe("http://reference.test/api")
		expect((await createMemoryReference()).url).toBe("http://reference.test")
	})
})
