import { afterEach, describe, expect, it, vi } from "vitest"
import { connectProbe, d1Available, postgresStatus, sqliteAvailable } from "./engines.ts"

const D1 = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN"] as const
const saved = { ...process.env }

afterEach(() => {
	process.env = { ...saved }
})

describe("engines", () => {
	it("hosts SQLite on this runtime", async () => {
		expect(await sqliteAvailable()).toBe(true)
	})

	it("calls SQLite unavailable on a runtime that cannot load it", async () => {
		expect(await sqliteAvailable(() => Promise.reject(new Error("No such built-in module: node:sqlite")))).toBe(false)
	})

	it("calls D1 available only with all three credentials", () => {
		for (const name of D1) process.env[name] = "x"
		expect(d1Available()).toBe(true)
		delete process.env.CLOUDFLARE_API_TOKEN
		expect(d1Available()).toBe(false)
	})

	it("calls Postgres unreachable when no server answers", async () => {
		process.env.PGHOST = "127.0.0.1"
		process.env.PGPORT = "1"
		expect(await postgresStatus()).toBe("unreachable")
	})

	it("tells a missing driver from a server that does not answer", async () => {
		const missing = Object.assign(new Error("Cannot find package 'postgres' imported from /app/x.js"), {
			code: "ERR_MODULE_NOT_FOUND",
		})
		expect(await postgresStatus(() => Promise.reject(missing))).toBe("no-driver")
	})

	it("calls Postgres ready when a server answers, and closes the session either way", async () => {
		const ended: number[] = []
		const answering = {
			end: async ({ timeout }: { timeout: number }) => void ended.push(timeout),
			unsafe: async () => [],
		}
		expect(await postgresStatus(async () => answering)).toBe("ready")
		const refusing = { ...answering, unsafe: () => Promise.reject(new Error("refused")) }
		expect(await postgresStatus(async () => refusing)).toBe("unreachable")
		expect(ended).toEqual([3, 3])
	})

	it("probes with one short-lived postgres.js session, its notices silenced", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {})
		const sql = await connectProbe()
		expect(sql.options).toMatchObject({ connect_timeout: 3, database: "postgres", max: 1 })
		sql.options.onnotice({ message: "probe" } as never)
		expect(log).not.toHaveBeenCalled()
		await sql.end({ timeout: 0 })
		log.mockRestore()
	})
})
