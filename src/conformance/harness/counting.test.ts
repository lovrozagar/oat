import { describe, expect, it } from "vitest"
import type { ProgressSnapshot } from "../../runtime/progress/types.ts"
import { respond } from "../../reference/http/wire.ts"
import { PRINCIPALS, SECURITY } from "../matrix/principals.ts"
import { counting, marker, requestLines, run, type Sent, sourcesOf, sumRequests } from "./counting.ts"
import { inProcess, reach, type Via } from "./launch.ts"

/* A transport behind no socket that answers every request 204, and the URLs it was sent. */
function recording(sent: string[]): typeof fetch {
	return async (input) => {
		sent.push(new Request(input).url)
		return new Response(null, { status: 204 })
	}
}

/* A Via whose hosted things have no transport of their own: what a socket gives. */
const SOCKETED: Via = {
	host: async () => ({ close: async () => {}, url: "http://socket.test" }),
	launch: async (backend, options) => {
		const launched = await inProcess.launch(backend, options)
		return { ...launched, fetch: undefined, url: "http://socket.test" }
	},
}

describe("counting", () => {
	it("counts each request sent to what it launches, through the launched transport", async () => {
		const counted = counting(inProcess)
		const reference = await counted.via.launch("memory", { dialect: "postgrest" })
		const send = reference.fetch as typeof fetch
		expect((await send(`${reference.url}/v1/openapi/spec`)).status).toBe(200)
		await send(`${reference.url}/v1/openapi/spec`)
		expect(counted.requests()).toEqual({ sources: { unattributed: 2 }, total: 2 })
		expect(Object.keys(await reference.snapshot())).toContain("table")
		expect(reference.createdIds()).toEqual({})
		await reference.close()
	})

	it("counts requests to what it hosts, across every launch and host of the leg", async () => {
		const counted = counting(inProcess)
		const hosted = await counted.via.host(async () => respond(200, { ok: true }))
		await (hosted.fetch as typeof fetch)(`${hosted.url}/anything`)
		const reference = await counted.via.launch("memory", {})
		await (reference.fetch as typeof fetch)(`${reference.url}/v1/openapi/spec`)
		expect(counted.requests().total).toBe(2)
		await hosted.close()
		await reference.close()
	})

	it("counts through the socket's transport when the hosted thing has none of its own", async () => {
		const sent: string[] = []
		const counted = counting(SOCKETED, recording(sent))
		const hosted = await counted.via.host(async () => respond(200, {}))
		const launched = await counted.via.launch("memory", {})
		await (hosted.fetch as typeof fetch)("http://socket.test/a")
		await (launched.fetch as typeof fetch)("http://socket.test/b")
		expect(sent).toEqual(["http://socket.test/a", "http://socket.test/b"])
		expect(counted.requests().total).toBe(2)
		await launched.close()
	})

	it("starts each counter at zero, apart from any other", async () => {
		const first = counting(inProcess)
		const second = counting(inProcess)
		const hosted = await first.via.host(async () => respond(200, {}))
		await (hosted.fetch as typeof fetch)(`${hosted.url}/x`)
		expect([first.requests().total, second.requests()]).toEqual([1, { sources: {}, total: 0 }])
	})
})

/* oat's run against the reference `reached` launched, as every conformance leg runs it. */
async function oatAgainst(reached: Via, onProgress?: () => void) {
	const reference = await reached.launch("memory", { dialect: "postgrest" })
	try {
		return await run({
			baseUrl: reference.url,
			only: ["table"],
			principals: PRINCIPALS,
			security: SECURITY,
			seed: 42,
			spec: `${reference.url}/v1/openapi/spec`,
			...(onProgress === undefined ? {} : { onProgress }),
			...reach(reference),
		})
	} finally {
		await reference.close()
	}
}

describe("run, counted by source", () => {
	it("splits every request a run sent by who sent it, and the document's load is no exchange", async () => {
		const counted = counting(inProcess)
		let moves = 0
		const result = await oatAgainst(counted.via, () => void (moves += 1))
		const { sources, total } = counted.requests()
		const sent = Object.values(sources).reduce((sum, count) => sum + count, 0)
		expect(sent).toBe(total)
		expect(total - (sources["unattributed"] ?? 0)).toBe(result.client.transcript.length)
		/* The document, fetched once before the run has a client to record it. */
		expect(sources["unattributed"]).toBe(1)
		expect(sources).toMatchObject({
			"check list.read-after-write": expect.any(Number),
			seed: expect.any(Number),
			teardown: expect.any(Number),
		})
		/* The caller's own progress listener still hears every move. */
		expect(moves).toBeGreaterThan(0)
	}, 120_000)

	it("leaves a run on a transport no counter wraps as it is", async () => {
		const result = await oatAgainst(inProcess)
		expect(result.client.transcript.length).toBeGreaterThan(0)
	}, 120_000)
})

describe("sumRequests and requestLines", () => {
	it("adds tallies source by source, and prints the total with its sources sorted by name", () => {
		const summed = sumRequests([
			{ sources: { seed: 2, "check b": 1 }, total: 3 },
			{ sources: { seed: 1, unattributed: 1 }, total: 2 },
		])
		expect(summed).toEqual({ sources: { "check b": 1, seed: 3, unattributed: 1 }, total: 5 })
		expect(requestLines(summed)).toBe(
			"  requests: 5\n  requests by source:\n    check b: 1\n    seed: 3\n    unattributed: 1\n",
		)
	})

	it("prints no source block for a leg that sent nothing", () => {
		expect(requestLines(sumRequests([]))).toBe("  requests: 0\n")
	})
})

/* A progress move as the run publishes it: its phase, the transcript's length, and the check it is on. */
function snap(phase: ProgressSnapshot["phase"], requests: number, check?: string): ProgressSnapshot {
	return { elapsedMs: 0, findings: 0, phase, requests, ...(check === undefined ? {} : { check }) }
}

describe("sourcesOf", () => {
	it("names a request by who sent it: the credential store, a check, a throwaway, a target read", () => {
		const sent: Sent[] = [
			{ issuedBy: "credentials", method: "POST", purpose: "auth" },
			{ check: "auth.scope-enforced", method: "GET", purpose: "assertion" },
			{ check: "list.read-after-write", method: "GET", purpose: "probe" },
			{ method: "POST", purpose: "probe" },
			{ method: "GET", purpose: "probe" },
			{ method: "HEAD", purpose: "probe" },
			{ method: "QUERY", purpose: "probe" },
		]
		expect(sourcesOf(sent, [])).toEqual({
			"check auth.scope-enforced": 1,
			"check list.read-after-write": 1,
			credentials: 1,
			"security overhead": 3,
			"throwaway creates": 1,
		})
	})

	it("names the rest by purpose: seeding, teardown, sign-ins, and a lane's own requests", () => {
		const sent: Sent[] = [
			{ method: "POST", purpose: "seed" },
			{ method: "DELETE", purpose: "teardown" },
			{ method: "POST", purpose: "auth" },
			{ method: "GET", purpose: "assertion" },
		]
		expect(sourcesOf(sent, [])).toEqual({ auth: 1, lanes: 1, seed: 1, teardown: 1 })
	})

	it("counts a request once per call it made, every redirect hop included", () => {
		expect(sourcesOf([{ method: "GET", purpose: "seed", redirects: [{}, {}] }], [])).toEqual({ seed: 3 })
	})

	it("names an untagged request before any stage by the load phase", () => {
		expect(sourcesOf([{ method: "GET" }], [])).toEqual({ "phase load": 1 })
	})
})

describe("sourcesOf, by stage", () => {
	it("names an untagged request by the stage it was sent in", () => {
		const progress = marker()
		for (const move of [
			snap("auth", 0),
			snap("test", 1, "list.read-after-write"),
			snap("scenario", 3),
			snap("test", 4),
			snap("contract", 5),
			snap("teardown", 7),
		])
			progress.onProgress(move)
		const untagged: Sent = { method: "GET" }
		expect(
			sourcesOf(
				Array.from({ length: 8 }, () => untagged),
				progress.marks,
			),
		).toEqual({
			"contract floor": 3,
			"phase auth": 1,
			"phase teardown": 1,
			"phase test": 2,
			scenarios: 1,
		})
	})
})

describe("marker", () => {
	it("keeps a mark only where the stage changes", () => {
		const progress = marker()
		for (const move of [snap("auth", 0), snap("auth", 2), snap("test", 2, "a"), snap("test", 5, "b")])
			progress.onProgress(move)
		expect(progress.marks).toEqual([
			{ at: 0, stage: "phase auth" },
			{ at: 2, stage: "phase test" },
		])
	})
})
