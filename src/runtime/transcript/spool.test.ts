import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.ts"
import { exchangeOf } from "../exchanges/__fixtures__/exchange.ts"
import { BodySpool, isSpooledBody, TRANSCRIPT_BODY_BUDGET } from "./spool.ts"

const exchange = (seq: number, body: unknown): Exchange =>
	exchangeOf({ requestBytes: 0, responseBody: body, responseBytes: 80, seq })

describe("transcript bodies past the memory budget", () => {
	it("move to disk, oldest first, and come back exactly", async () => {
		expect(TRANSCRIPT_BODY_BUDGET).toBe(32 * 1024 * 1024)
		const spool = new BodySpool(100)
		const first = exchange(1, { rows: "a".repeat(80) })
		const second = exchange(2, { rows: "b".repeat(80) })
		await spool.keep(first)
		await spool.keep(second)
		expect(isSpooledBody(first.responseBody)).toBe(true)
		expect(isSpooledBody(second.responseBody)).toBe(false)
		expect((await spool.hydrate(first)).responseBody).toEqual({ rows: "a".repeat(80) })
		expect(await spool.hydrate(second)).toBe(second)
		await spool.dispose()
	})

	it("hold no more than the budget in memory, however long the run", async () => {
		const budget = 64 * 1024
		const spool = new BodySpool(budget)
		const kept: Exchange[] = []
		for (let seq = 1; seq <= 500; seq++) {
			const sent = { ...exchange(seq, { rows: "x".repeat(8 * 1024) }), responseBytes: 8 * 1024 }
			kept.push(sent)
			await spool.keep(sent)
			const resident = kept.filter((each) => !isSpooledBody(each.responseBody)).length
			expect(resident * 8 * 1024).toBeLessThanOrEqual(budget)
		}
		expect((await spool.hydrate(kept[0] as Exchange)).responseBody).toEqual({ rows: "x".repeat(8 * 1024) })
		await spool.dispose()
	})

	it("come back when concurrent requests spool their first bodies at once", async () => {
		const spool = new BodySpool(100)
		const sent = Array.from({ length: 8 }, (_, index) => exchange(index + 1, { rows: String(index).repeat(80) }))
		await Promise.all(sent.map((each) => spool.keep(each)))
		for (const [index, each] of sent.entries()) {
			expect((await spool.hydrate(each)).responseBody).toEqual({ rows: String(index).repeat(80) })
		}
		await spool.dispose()
	})
})

describe("spooled bodies, at the edges", () => {
	it("moves a request body when there is no response body, and reads it back", async () => {
		const spool = new BodySpool(10)
		const posted: Exchange = { ...exchange(1, undefined), requestBody: { name: "x".repeat(40) }, requestBytes: 40 }
		await spool.keep(posted)
		await spool.keep(exchange(2, { ok: true }))
		expect(isSpooledBody(posted.requestBody)).toBe(true)
		expect(posted.responseBody).toBeUndefined()
		expect((await spool.hydrate(posted)).requestBody).toEqual({ name: "x".repeat(40) })
		await spool.dispose()
		await spool.dispose()
	})

	it("keeps the only body it holds, however large, and knows a marker", async () => {
		const spool = new BodySpool(1)
		const only = exchange(1, { big: true })
		await spool.keep(only)
		expect(only.responseBody).toEqual({ big: true })
		expect([{ spooled: 1 }, { spooled: "1" }, null, "x"].map(isSpooledBody)).toEqual([true, false, false, false])
		await spool.dispose()
		expect(await new BodySpool().hydrate(only)).toBe(only)
	})
})
