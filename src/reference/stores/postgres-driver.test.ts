import { describe, expect, it } from "vitest"
import { UsageError } from "../../errors/usage-error.ts"
import { isMissingPostgres, loadPostgres, POSTGRES_RANGE } from "./postgres-driver.ts"

/* `postgres` is an optional peer: an install without it asks for it, and nothing else is excused. */

const missing = (name: string): Error =>
	Object.assign(new Error(`Cannot find package '${name}' imported from /app/dist/reference/stores/postgres.js`), {
		code: "ERR_MODULE_NOT_FOUND",
	})

describe("loadPostgres", () => {
	it("hands back what the import resolves", async () => {
		const module = { PgStore: "store" }
		expect(await loadPostgres(async () => module)).toBe(module)
	})

	it("asks for the driver, by its range, when the install lacks it", async () => {
		const asked = loadPostgres(() => Promise.reject(missing("postgres")))
		await expect(asked).rejects.toBeInstanceOf(UsageError)
		await expect(loadPostgres(() => Promise.reject(missing("postgres")))).rejects.toThrow(
			`oat: --backend postgres needs the postgres package (${POSTGRES_RANGE}): npm install postgres`,
		)
	})

	it("lets any other failure through as it is", async () => {
		const other = missing("postgres-bridge")
		await expect(loadPostgres(() => Promise.reject(other))).rejects.toBe(other)
		const broken = new Error("postgres exploded")
		await expect(loadPostgres(() => Promise.reject(broken))).rejects.toBe(broken)
	})
})

describe("isMissingPostgres", () => {
	it("is only a module-not-found that names the postgres package", () => {
		expect(isMissingPostgres(missing("postgres"))).toBe(true)
		expect(isMissingPostgres(missing("postgres-bridge"))).toBe(false)
		expect(isMissingPostgres(new Error("Cannot find package 'postgres'"))).toBe(false)
		expect(isMissingPostgres("postgres")).toBe(false)
	})
})
