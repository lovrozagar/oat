import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import type { Exchange } from "../../src/runtime/exchange.ts"
import { run } from "../../src/runtime/run/index.ts"
import { Redactor } from "../../src/security/redact.ts"
import { listen, scratch, WidgetWorld } from "../support/exchanges-fixtures.ts"

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

describe("exchange journal from a run", () => {
	it("flushes from Client.onExchange and skips the dir when save is off", async () => {
		const world = new WidgetWorld()
		const server = await listen((req, res) => {
			world.handle(req, res)
		})
		closers.push(server.close)
		const { url } = server
		const on = await scratch()
		const saved = await run({
			baseUrl: url,
			cohortSize: 1,
			exchangeDir: on,
			only: ["widget"],
			principals: { a: {} },
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})
		expect(saved.exchanges?.count).toBeGreaterThan(0)
		expect(existsSync(join(on, "exchanges.jsonl"))).toBe(true)
		expect(existsSync(join(on, "exchanges"))).toBe(true)
		const listing = await readdir(join(on, "exchanges"))
		expect(listing.length).toBe(saved.exchanges?.count)

		const off = await scratch()
		const skipped = await run({
			baseUrl: url,
			cohortSize: 1,
			only: ["widget"],
			principals: { a: {} },
			seed: 1,
			spec: `${url}/v1/openapi/spec`,
		})
		expect(skipped.exchanges).toBeUndefined()
		expect(existsSync(join(off, "exchanges"))).toBe(false)
	})
})

describe("Client records operationId and fixture on the exchange", () => {
	it("copies them through for the journal", async () => {
		const server = await listen((_req, res) => {
			res.writeHead(200, { "content-type": "application/json", "x-request-id": "from-server" })
			res.end("{}")
		})
		closers.push(server.close)
		const seen: Exchange[] = []
		const client = new Client({
			baseUrl: server.url,
			headers: {},
			maxInFlight: 4,
			onExchange: (item) => {
				seen.push(item)
			},
			redactor: new Redactor(),
		})
		const pdfRead = await client.get("/v1/x", { as: { anonymous: true }, fixture: "a.pdf", operationId: "x.read" })
		expect(pdfRead.operationId).toBe("x.read")
		expect(pdfRead.fixture).toBe("a.pdf")
		expect(pdfRead.requestId).toBe("from-server")
		expect(seen).toHaveLength(1)
	})
})
