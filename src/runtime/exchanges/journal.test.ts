import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { REDACTED, Redactor } from "../../security/redact.ts"
import { exchangeOf } from "./__fixtures__/exchange.ts"
import { createExchangeJournal } from "./journal.ts"

let dir = ""

const indexLines = (): Array<Record<string, unknown>> =>
	readFileSync(join(dir, "exchanges.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>)
const fileOf = (rel: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(dir, rel), "utf8")) as Record<string, unknown>

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "oat-journal-"))
})

afterEach(() => {
	rmSync(dir, { force: true, recursive: true })
})

describe("createExchangeJournal, one exchange", () => {
	it("queues the exchange's file and index line until flushed", async () => {
		const journal = createExchangeJournal(dir, new Redactor())
		expect([journal.dir, journal.count]).toEqual([dir, 0])
		await journal.flush()
		expect(existsSync(join(dir, "exchanges.jsonl"))).toBe(false)
		await journal.record(exchangeOf())
		expect([journal.count, existsSync(join(dir, "exchanges.jsonl"))]).toEqual([1, false])
		await journal.flush()
		const [line] = indexLines()
		expect(line).toEqual({
			at: 1_800_000_000_000,
			durationMs: 12,
			file: "exchanges/req-1.json",
			method: "GET",
			requestBytes: 40,
			requestId: "req-1",
			responseBytes: 80,
			seq: 1,
			status: 200,
			url: "http://h.test/v1/items",
		})
		expect(Object.keys(fileOf("exchanges/req-1.json"))).toEqual([
			"at",
			"durationMs",
			"method",
			"requestHeaders",
			"requestId",
			"responseBody",
			"responseHeaders",
			"seq",
			"status",
			"url",
		])
	})
})

describe("createExchangeJournal, a full exchange", () => {
	it("writes everything an exchange carries, redacted, and the context it was made in", async () => {
		const redactor = new Redactor()
		redactor.registerSecret("s3cret-value")
		const journal = createExchangeJournal(dir, redactor)
		const exchange = exchangeOf({
			finalUrl: "http://h.test/v1/items/2",
			fixture: "a.png",
			operationId: "items.list",
			redirects: [
				{ responseHeaders: { "set-cookie": "sid=1" }, status: 303, url: "http://h.test/v1/go?k=s3cret-value" },
			],
			requestBody: { password: "p" },
			requestHeaders: { authorization: "Bearer t" },
			url: "http://h.test/v1/items?k=s3cret-value",
		})
		await journal.record(exchange, { check: "list.pages", entity: "items", phase: "test" })
		await journal.flush()
		const [line] = indexLines()
		expect(line).toMatchObject({
			check: "list.pages",
			entity: "items",
			finalUrl: "http://h.test/v1/items/2",
			fixture: "a.png",
			operationId: "items.list",
			phase: "test",
			redirects: 1,
		})
		expect(String(line?.url)).not.toContain("s3cret-value")
		const file = fileOf("exchanges/req-1.json")
		expect(Object.keys(file)).toEqual([
			"at",
			"durationMs",
			"fixture",
			"finalUrl",
			"method",
			"operationId",
			"requestBody",
			"requestHeaders",
			"requestId",
			"responseBody",
			"responseHeaders",
			"redirects",
			"seq",
			"status",
			"url",
		])
		expect([file.requestBody, file.requestHeaders]).toEqual([{ password: REDACTED }, { authorization: REDACTED }])
		expect(JSON.stringify(file.redirects)).not.toContain("s3cret-value")
	})
})

describe("createExchangeJournal, many exchanges", () => {
	it("names each file apart, around files an earlier journal left", async () => {
		mkdirSync(join(dir, "exchanges"), { recursive: true })
		writeFileSync(join(dir, "exchanges", "req-1.json"), "{}")
		writeFileSync(join(dir, "exchanges", "req-1-2.json"), "{}")
		const journal = createExchangeJournal(dir, new Redactor())
		await journal.record(exchangeOf({ seq: 2 }))
		await journal.record(exchangeOf({ requestId: "", seq: 3 }))
		await journal.record(exchangeOf({ seq: 4 }))
		await journal.flush()
		expect(indexLines().map((line) => line.file)).toEqual([
			"exchanges/req-1-2-2.json",
			"exchanges/seq-3.json",
			"exchanges/req-1-4.json",
		])
	})

	it("appends the index in batches of 64 without being asked", async () => {
		const journal = createExchangeJournal(dir, new Redactor())
		for (let seq = 1; seq <= 64; seq++) await journal.record(exchangeOf({ requestId: `r${seq}`, seq }))
		expect(indexLines()).toHaveLength(64)
		await journal.record(exchangeOf({ requestId: "r65", seq: 65 }))
		expect([indexLines().length, journal.count]).toEqual([64, 65])
		await journal.flush()
		expect(indexLines()).toHaveLength(65)
	})
})
