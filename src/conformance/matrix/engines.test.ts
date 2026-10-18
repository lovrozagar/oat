import { afterEach, describe, expect, it } from "vitest"
import { d1Available, postgresAvailable, sqliteAvailable } from "./engines.ts"

const D1 = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN"] as const
const saved = { ...process.env }

afterEach(() => {
	process.env = { ...saved }
})

describe("engines", () => {
	it("hosts SQLite on this runtime", async () => {
		expect(await sqliteAvailable()).toBe(true)
	})

	it("calls D1 available only with all three credentials", () => {
		for (const name of D1) process.env[name] = "x"
		expect(d1Available()).toBe(true)
		delete process.env.CLOUDFLARE_API_TOKEN
		expect(d1Available()).toBe(false)
	})

	it("calls Postgres unavailable when no server answers", async () => {
		process.env.PGHOST = "127.0.0.1"
		process.env.PGPORT = "1"
		expect(await postgresAvailable()).toBe(false)
	})
})
