import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.ts"
import { exchangeOf } from "../exchanges/__fixtures__/exchange.ts"
import { BodySpool, isSpooledBody, TRANSCRIPT_BODY_BUDGET } from "./spool.ts"

const exchange = (seq: number, body: unknown): Exchange =>
	exchangeOf({ requestBytes: 0, responseBody: body, responseBytes: 80, seq })

describe("transcript bodies past the memory budget", () => {
	it("move to disk, oldest first, and come back exactly", async () => {
		expect(TRANSCRIPT_BODY_BUDGET).toBe(32 * 1024 * 1024)
		const spool = new BodySpool({ memoryBytes: 100 })
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
		const spool = new BodySpool({ memoryBytes: budget })
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
		const spool = new BodySpool({ memoryBytes: 100 })
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
		const spool = new BodySpool({ memoryBytes: 10 })
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
		const spool = new BodySpool({ memoryBytes: 1 })
		const only = exchange(1, { big: true })
		await spool.keep(only)
		expect(only.responseBody).toEqual({ big: true })
		expect([{ spooled: 1 }, { spooled: "1" }, null, "x"].map(isSpooledBody)).toEqual([true, false, false, false])
		await spool.dispose()
		expect(await new BodySpool().hydrate(only)).toBe(only)
	})
})

describe("spooled bodies on disk", () => {
	it("are never written in the clear: a login's tokens moved out of memory stay unreadable there", async () => {
		const root = mkdtempSync(join(tmpdir(), "oat-spool-root-"))
		try {
			const spool = new BodySpool({ dir: root, memoryBytes: 100 })
			const login = { access_token: "acc-9f8e7d6c5b", refresh_token: "ref-1a2b3c4d5e", pad: "p".repeat(80) }
			const first: Exchange = { ...exchange(1, login), requestBody: { key: "key_alpha" }, requestBytes: 20 }
			await spool.keep(first)
			await spool.keep(exchange(2, { rows: "b".repeat(80) }))
			expect(isSpooledBody(first.responseBody)).toBe(true)
			const written = readdirSync(root, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"))
			expect(written).toHaveLength(1)
			for (const secret of ["acc-9f8e7d6c5b", "ref-1a2b3c4d5e", "key_alpha"]) {
				expect(written.some((text) => text.includes(secret))).toBe(false)
			}
			const back = await spool.hydrate(first)
			expect([back.responseBody, back.requestBody]).toEqual([login, { key: "key_alpha" }])
			await spool.dispose()
		} finally {
			rmSync(root, { force: true, recursive: true })
		}
	})
})

/* Every file the spool under `root` wrote, by path. */
function spooled(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
}

/* A spool under a fresh root that has moved one body, `body`, to disk. */
async function oneSpooled(root: string, body: unknown): Promise<{ spool: BodySpool; first: Exchange }> {
	const spool = new BodySpool({ dir: root, memoryBytes: 100 })
	const first = exchange(1, body)
	await spool.keep(first)
	await spool.keep(exchange(2, { rows: "b".repeat(80) }))
	return { first, spool }
}

describe("spooled bodies, sealed", () => {
	const body = { access_token: "acc-9f8e7d6c5b", pad: "p".repeat(80) }

	it("never write the same bytes twice for the same body: a fresh nonce, a key of each spool's own", async () => {
		const root = mkdtempSync(join(tmpdir(), "oat-spool-seal-"))
		try {
			const one = await oneSpooled(root, body)
			const [first] = spooled(root)
			const two = await oneSpooled(root, body)
			const second = spooled(root).find((path) => path !== first) as string
			expect(readFileSync(first as string).equals(readFileSync(second))).toBe(false)
			await one.spool.dispose()
			await two.spool.dispose()
			/* Within one spool, under one key, the nonce alone keeps the same body apart. */
			const same = new BodySpool({ dir: root, memoryBytes: 100 })
			for (const seq of [1, 2, 3]) await same.keep(exchange(seq, body))
			const [a, b] = spooled(root).map((path) => readFileSync(path)) as [Buffer, Buffer]
			expect(a.equals(b)).toBe(false)
			await same.dispose()
		} finally {
			rmSync(root, { force: true, recursive: true })
		}
	})

	it("throws on a file altered or cut short, never decrypting it to garbage", async () => {
		const root = mkdtempSync(join(tmpdir(), "oat-spool-tamper-"))
		try {
			const { first, spool } = await oneSpooled(root, body)
			const [path] = spooled(root) as [string]
			const sealed = readFileSync(path)
			const flipped = Buffer.from(sealed)
			flipped[flipped.length - 1] = (flipped.at(-1) as number) ^ 1
			writeFileSync(path, flipped)
			await expect(spool.hydrate(first)).rejects.toThrow("the spooled body of exchange 1 failed authentication")
			writeFileSync(path, sealed.subarray(0, 20))
			await expect(spool.hydrate(first)).rejects.toThrow("failed authentication: altered or truncated")
			await spool.dispose()
		} finally {
			rmSync(root, { force: true, recursive: true })
		}
	})
})

describe("spooled bodies, when the process exits first", () => {
	const body = { access_token: "acc-9f8e7d6c5b", pad: "p".repeat(80) }

	it("are removed if the process exits before the spool is disposed of, and stop listening once it is", async () => {
		const root = mkdtempSync(join(tmpdir(), "oat-spool-exit-"))
		try {
			const before = process.listeners("exit").length
			const { spool } = await oneSpooled(root, body)
			const listeners = process.listeners("exit")
			expect(listeners).toHaveLength(before + 1)
			;(listeners.at(-1) as () => void)()
			expect(readdirSync(root)).toEqual([])
			await spool.dispose()
			expect(process.listeners("exit")).toHaveLength(before)
			const again = await oneSpooled(root, body)
			await again.spool.dispose()
			expect([readdirSync(root), process.listeners("exit").length]).toEqual([[], before])
		} finally {
			rmSync(root, { force: true, recursive: true })
		}
	})
})

describe("a spool disposed of while its directory is still being made", () => {
	it("leaves no exit listener behind", async () => {
		const root = mkdtempSync(join(tmpdir(), "oat-spool-race-"))
		try {
			const before = process.listeners("exit").length
			const spool = new BodySpool({ dir: root, memoryBytes: 100 })
			await spool.keep(exchange(1, { rows: "a".repeat(80) }))
			const spooling = spool.keep(exchange(2, { rows: "b".repeat(80) }))
			await spool.dispose()
			await spooling.catch(() => undefined)
			expect(process.listeners("exit")).toHaveLength(before)
		} finally {
			rmSync(root, { force: true, recursive: true })
		}
	})
})
