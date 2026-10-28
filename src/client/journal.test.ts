import { describe, expect, it } from "vitest"
import type { Exchange } from "../runtime/exchange.ts"
import { Redactor } from "../security/redact.ts"
import { Journal } from "./journal.ts"

const exchange = (seq: number, more: Partial<Exchange> = {}): Exchange => ({
	at: 0,
	durationMs: 0,
	method: "GET",
	requestBody: undefined,
	requestBytes: 10,
	requestHeaders: {},
	requestId: "",
	responseBody: { ok: true },
	responseBytes: 10,
	responseHeaders: {},
	seq,
	status: 200,
	url: "http://api.test/rows",
	...more,
})

describe("Journal", () => {
	it("keeps a scrubbed copy, leaving the caller's exchange whole", async () => {
		const redactor = new Redactor()
		const journal = new Journal(redactor)
		const sent = exchange(1, { requestBody: new URLSearchParams({ password: "p" }) })
		await journal.record(sent, undefined)
		expect(journal.transcript).toHaveLength(1)
		expect(journal.transcript[0]?.requestBody).toEqual({ password: "<redacted>" })
		expect(sent.requestBody).toBeInstanceOf(URLSearchParams)
	})

	it("indexes by operation and by entity, in order", async () => {
		const journal = new Journal(new Redactor())
		await journal.record(exchange(1, { operationId: "row.list" }), "row")
		await journal.record(exchange(2), "row")
		await journal.record(exchange(3, { operationId: "row.list" }), undefined)
		expect(journal.exchangesFor("row.list").map((e) => e.seq)).toEqual([1, 3])
		expect(journal.exchangesForEntity("row").map((e) => e.seq)).toEqual([1, 2])
		expect(journal.exchangesFor("none")).toEqual([])
		expect(journal.exchangesForEntity("none")).toEqual([])
	})

	it("marks a superseded answer on its kept copy, and ignores one it never kept", async () => {
		const journal = new Journal(new Redactor())
		const first = exchange(1)
		await journal.record(first, undefined)
		journal.supersede(first)
		journal.supersede(exchange(9))
		expect(journal.transcript[0]?.superseded).toBe(true)
	})

	it("hydrates an exchange still held in memory as it is, and disposes", async () => {
		const journal = new Journal(new Redactor())
		const kept = exchange(1)
		await journal.record(kept, undefined)
		const stored = journal.transcript[0] as Exchange
		expect(await journal.hydrate(stored)).toBe(stored)
		await expect(journal.dispose()).resolves.toBeUndefined()
	})
})

describe("Journal: a schema verdict taken at capture", () => {
	const large = { rows: "x".repeat(300_000) }
	const headers = { "content-type": "application/json" }
	const big = { responseBody: large, responseBytes: 300_011, responseHeaders: headers }

	it("keeps the verdict beside a body the transcript holds only by reference, asked of the whole body", async () => {
		const asked: unknown[] = []
		const validateAtCapture = (whole: Exchange) => {
			asked.push(whole.responseBody)
			return { errors: ["/rows must be array"] }
		}
		const journal = new Journal(new Redactor(), { validateAtCapture })
		await journal.record(exchange(1, big), undefined)
		expect(journal.transcript[0]?.schemaVerdict).toEqual({ errors: ["/rows must be array"] })
		expect(asked).toEqual([large])
	})

	it("asks nothing of a body kept whole, and keeps no verdict where none is given", async () => {
		const asked: unknown[] = []
		const journal = new Journal(new Redactor(), {
			validateAtCapture: (whole) => {
				asked.push(whole.seq)
				return undefined
			},
		})
		await journal.record(exchange(1), undefined)
		await journal.record(exchange(2, big), undefined)
		expect(asked).toEqual([2])
		expect(journal.transcript.map((kept) => kept.schemaVerdict)).toEqual([undefined, undefined])
		const without = new Journal(new Redactor())
		await without.record(exchange(3, big), undefined)
		expect(without.transcript[0]?.schemaVerdict).toBeUndefined()
	})
})
