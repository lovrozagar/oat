import { afterEach, describe, expect, it, vi } from "vitest"
import { d1Driver, nodeSqliteDriver } from "./sqlite-driver.ts"

const CONFIG = { accountId: "acct", apiToken: "secret", databaseId: "db" }
const ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query"

interface Sent {
	url: string
	init: RequestInit
}

/* D1's query API answering every call with `body` under `status`, recording what was sent. */
function stubD1(body: unknown, status = 200): Sent[] {
	const sent: Sent[] = []
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		sent.push({ init, url })
		return Response.json(body, { status })
	})
	return sent
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("nodeSqliteDriver", () => {
	it("runs DDL, writes and reads on an in-memory database without the DQS fallback", async () => {
		const driver = await nodeSqliteDriver()
		expect({ dqs: driver.dqs, engine: driver.engine }).toEqual({ dqs: false, engine: "sqlite" })
		await driver.exec('CREATE TABLE "t" ("id" TEXT, "n" INTEGER)')
		await driver.run('INSERT INTO "t" VALUES (?, ?)', ["a", 1])
		expect(await driver.all('SELECT * FROM "t" WHERE "id" = ?', ["a"])).toEqual([{ id: "a", n: 1 }])
		await expect(driver.all('SELECT "missing" FROM "t"', [])).rejects.toThrow("no such column")
		await driver.close()
	})

	it("matches LIKE case-sensitively", async () => {
		const driver = await nodeSqliteDriver()
		expect(await driver.all("SELECT 'Abc' LIKE 'abc' AS matched", [])).toEqual([{ matched: 0 }])
		await driver.close()
	})
})

describe("d1Driver", () => {
	it("posts each statement with its parameters as JSON, under the token", async () => {
		const sent = stubD1({ result: [{ results: [{ id: "a" }] }], success: true })
		const driver = d1Driver(CONFIG)
		expect({ dqs: driver.dqs, engine: driver.engine }).toEqual({ dqs: true, engine: "d1" })
		expect(await driver.all("SELECT ?", ["a", 1, null, new Uint8Array([1, 2])])).toEqual([{ id: "a" }])
		await driver.run("DELETE", [])
		await driver.exec("CREATE")
		await driver.close()
		expect(sent.map(({ url }) => url)).toEqual([ENDPOINT, ENDPOINT, ENDPOINT])
		expect(sent[0]?.init).toEqual({
			body: JSON.stringify({ params: ["a", 1, null, "AQI="], sql: "SELECT ?" }),
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
			method: "POST",
		})
		expect(JSON.parse(String(sent[2]?.init.body))).toEqual({ params: [], sql: "CREATE" })
	})

	it("answers no rows when the result carries none", async () => {
		stubD1({ success: true })
		expect(await d1Driver(CONFIG).all("SELECT 1", [])).toEqual([])
		stubD1({ result: [{}], success: true })
		expect(await d1Driver(CONFIG).all("SELECT 1", [])).toEqual([])
	})

	it("fails with D1's own errors, and the statement it refused", async () => {
		stubD1({
			errors: [
				{ code: 7500, message: "no such table" },
				{ code: 1, message: "again" },
			],
			success: false,
		})
		await expect(d1Driver(CONFIG).all("SELECT * FROM gone", [])).rejects.toThrow(
			"D1 query failed (7500: no such table; 1: again) for: SELECT * FROM gone",
		)
	})

	it("fails with the HTTP status when the response says nothing, even if it claims success", async () => {
		stubD1({ success: true }, 429)
		await expect(d1Driver(CONFIG).run(`INSERT ${"x".repeat(200)}`, [])).rejects.toThrow(
			`D1 query failed (HTTP 429) for: INSERT ${"x".repeat(153)}`,
		)
	})
})
