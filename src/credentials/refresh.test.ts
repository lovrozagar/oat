import { describe, expect, it } from "vitest"
import { createRenewals, isStale } from "./refresh.ts"

/** A credential issued at 0 that lapses at `expiresAt`. */
function lapsingAt(expiresAt: number | null): { expiresAt: number | null; issuedAt: number } {
	return { expiresAt, issuedAt: 0 }
}

describe("isStale", () => {
	it("is true once the credential is within the buffer of lapsing, and never for one that does not lapse", () => {
		const at = { bufferMs: 30_000, now: 100_000 }
		expect([
			isStale(lapsingAt(130_001), at),
			isStale(lapsingAt(130_000), at),
			isStale(lapsingAt(50_000), at),
			isStale(lapsingAt(null), at),
		]).toEqual([false, true, true, false])
	})
})

describe("isStale: short lifetimes", () => {
	it("caps the buffer at half the lifetime, so a 20 s credential is fresh at +5 s and stale at +11 s", () => {
		const short = lapsingAt(20_000)
		expect([
			isStale(short, { bufferMs: 30_000, now: 5_000 }),
			isStale(short, { bufferMs: 30_000, now: 11_000 }),
		]).toEqual([false, true])
	})
})

describe("createRenewals", () => {
	it("starts one renewal per held entry, however many callers ask at once", async () => {
		const once = createRenewals<{ value: string }, string>()
		const held = { value: "v1" }
		let started = 0
		const start = async (): Promise<string> => {
			started++
			await Promise.resolve()
			return `v${started + 1}`
		}
		const results = await Promise.all(Array.from({ length: 10 }, () => once(held, start)))
		expect([started, new Set(results)]).toEqual([1, new Set(["v2"])])
		expect(await once(held, start)).toBe("v2")
		expect([await once({ value: "v2" }, start), started]).toEqual(["v3", 2])
	})

	it("keeps renewals apart between two sets, so nothing outlives the run that made it", async () => {
		const held = { value: "v1" }
		const first = createRenewals<object, number>()
		const second = createRenewals<object, number>()
		expect([await first(held, () => Promise.resolve(1)), await second(held, () => Promise.resolve(2))]).toEqual([1, 2])
	})
})
