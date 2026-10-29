import { describe, expect, it } from "vitest"
import { DefectSet as Defects } from "../defects/defect-set.ts"
import { CACHE_BYPASS } from "../spec/consistency.ts"
import { type CacheHolder, cachedRead } from "./read-cache.ts"
import { type ReferenceRequest, respond } from "./wire.ts"

function holder(defects: string[] = [], cachedReads = true): CacheHolder & { at: (ms: number) => void } {
	let now = 0
	return {
		at: (ms) => {
			now = ms
		},
		clock: () => now,
		defects: new Defects(defects),
		readCache: new Map(),
		shape: { cachedReads },
	}
}

const get = (headers: Record<string, string> = {}): ReferenceRequest => ({
	headers,
	method: "GET",
	text: async () => "",
	url: new URL("http://ref.test/tables/t1"),
})

/* The origin answers the version it is on, so a test can tell a cached answer from a fresh one. */
function origin() {
	let version = 0
	return {
		bump: () => {
			version += 1
		},
		read: async () => respond(200, { version }),
	}
}

const served = async (state: CacheHolder, request: ReferenceRequest, from: ReturnType<typeof origin>) => {
	const answer = await cachedRead(state, { request, who: "alpha" }, from.read)
	return { body: JSON.parse(answer.body) as { version: number }, headers: answer.headers }
}

describe("cachedRead", () => {
	it("answers from the origin when the shape caches nothing", async () => {
		const state = holder([], false)
		const from = origin()
		await served(state, get(), from)
		from.bump()
		const answer = await served(state, get(), from)
		expect(answer.body.version).toBe(1)
		expect(answer.headers["cache-status"]).toBeUndefined()
	})

	it("serves its copy inside 400 ms, with Age and a hit, and asks the origin again after", async () => {
		const state = holder()
		const from = origin()
		expect((await served(state, get(), from)).headers["cache-status"]).toBe("oat-reference; fwd=uri-miss; stored")
		from.bump()
		state.at(399)
		expect(await served(state, get(), from)).toMatchObject({
			body: { version: 0 },
			headers: { age: "0", "cache-status": "oat-reference; hit" },
		})
		state.at(400)
		expect((await served(state, get(), from)).body.version).toBe(1)
	})

	it("keeps each caller's copy apart", async () => {
		const state = holder()
		const from = origin()
		await served(state, get(), from)
		from.bump()
		const other = await cachedRead(state, { request: get(), who: "beta" }, from.read)
		expect(JSON.parse(other.body)).toEqual({ version: 1 })
	})
})

describe("cachedRead and the bypass", () => {
	it("asks the origin past its copy on the bypass header", async () => {
		const state = holder()
		const from = origin()
		await served(state, get(), from)
		from.bump()
		expect(await served(state, get({ [CACHE_BYPASS.name]: CACHE_BYPASS.value }), from)).toMatchObject({
			body: { version: 1 },
			headers: { "cache-status": "oat-reference; fwd=bypass" },
		})
	})

	it("keeps its copy for 2500 ms under STALE_PAST_BOUND", async () => {
		const state = holder(["STALE_PAST_BOUND"])
		const from = origin()
		await served(state, get(), from)
		from.bump()
		state.at(2499)
		expect(await served(state, get(), from)).toMatchObject({ body: { version: 0 }, headers: { age: "2" } })
	})

	it("serves its copy to the bypass too under BYPASS_IGNORED", async () => {
		const state = holder(["BYPASS_IGNORED"])
		const from = origin()
		await served(state, get(), from)
		from.bump()
		expect(await served(state, get({ [CACHE_BYPASS.name]: CACHE_BYPASS.value }), from)).toMatchObject({
			body: { version: 0 },
			headers: { "cache-status": "oat-reference; hit" },
		})
	})

	it("fills no copy from a read sent the bypass, even under BYPASS_IGNORED", async () => {
		const bypass = get({ [CACHE_BYPASS.name]: CACHE_BYPASS.value })
		for (const state of [holder(), holder(["BYPASS_IGNORED"])]) {
			const from = origin()
			await served(state, bypass, from)
			from.bump()
			expect((await served(state, get(), from)).body.version).toBe(1)
		}
	})

	it("stores no answer but a 200", async () => {
		const state = holder()
		let status = 404
		const read = async () => respond(status, {})
		await cachedRead(state, { request: get(), who: "alpha" }, read)
		status = 200
		expect((await cachedRead(state, { request: get(), who: "alpha" }, read)).status).toBe(200)
	})
})
