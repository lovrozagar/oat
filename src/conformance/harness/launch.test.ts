import { afterEach, describe, expect, it } from "vitest"
import { memoryStore, postgresStore, sqliteStore } from "../../reference/http/engines.ts"
import { respond } from "../../reference/http/wire.ts"
import { inProcess, launch, listeningVia, reach, storeFor, type Via } from "./launch.ts"

const D1 = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN"] as const
const saved = { ...process.env }

afterEach(() => {
	process.env = { ...saved }
})

type Create = NonNullable<Parameters<typeof listeningVia>[0]>

/* A stand-in for node:http's server factory that listens nowhere and records what was asked of it. */
function fakeCreate(log: string[]): Create {
	const server = {
		address: () => ({ address: "127.0.0.1", family: "IPv4", port: 4321 }),
		close: (done: () => void) => (log.push("close"), done()),
		closeAllConnections: () => log.push("drop"),
		listen: (port: number, host: string, ready: () => void) => (log.push(`listen ${port} ${host}`), ready()),
	}
	return (() => server) as unknown as Create
}

const answer = async () => respond(200, { ok: true })

describe("storeFor", () => {
	it("runs each engine on its own store", () => {
		expect(storeFor("memory")).toBe(memoryStore)
		expect(storeFor("sqlite")).toBe(sqliteStore)
		expect(storeFor("postgres")).toBe(postgresStore)
	})

	it("reads D1's credentials up front, and refuses without them", () => {
		for (const name of D1) delete process.env[name]
		expect(() => storeFor("d1")).toThrow(/D1 backend needs CLOUDFLARE_ACCOUNT_ID/)
		for (const name of D1) process.env[name] = "x"
		expect(storeFor("d1")).toBeTypeOf("function")
	})
})

describe("inProcess", () => {
	it("launches the reference with no socket, reached through its own transport", async () => {
		const reference = await inProcess.launch("memory", { dialect: "postgrest" })
		const send = reference.fetch as typeof fetch
		expect(reference.url).toBe("http://reference.test")
		expect((await send(`${reference.url}/v1/openapi/spec`)).status).toBe(200)
		expect(Object.keys(await reference.snapshot())).toContain("table")
		expect(reference.createdIds()).toEqual({})
		await reference.close()
	})

	it("hosts a handler the same way", async () => {
		const hosted = await inProcess.host(answer)
		const send = hosted.fetch as typeof fetch
		expect(await (await send(`${hosted.url}/anything`)).json()).toEqual({ ok: true })
		await expect(hosted.close()).resolves.toBeUndefined()
	})
})

describe("listeningVia", () => {
	it("serves the reference and a handler on a local port, and drops them on close", async () => {
		const log: string[] = []
		const via = listeningVia(fakeCreate(log))
		const reference = await via.launch("memory", {})
		expect(reference.url).toBe("http://127.0.0.1:4321")
		expect(reference.fetch).toBeUndefined()
		await reference.close()
		const hosted = await via.host(answer)
		expect(hosted.url).toBe("http://127.0.0.1:4321")
		await hosted.close()
		expect(log).toEqual(["listen 0 127.0.0.1", "drop", "close", "listen 0 127.0.0.1", "drop", "close"])
	})
})

describe("launch", () => {
	it("launches the target's engine with its dialect, its shape when it has one, and the options", async () => {
		const asked: unknown[] = []
		const via: Via = {
			host: () => Promise.reject(new Error("unused")),
			launch: (backend, options) => (asked.push([backend, options]), inProcess.launch(backend, options)),
		}
		await (await launch({ backend: "memory", dialect: "classic", via }, { untagged: true })).close()
		await (await launch({ backend: "memory", dialect: "postgrest", shape: "path-prefix", via }, {})).close()
		expect(asked).toEqual([
			["memory", { dialect: "classic", untagged: true }],
			["memory", { dialect: "postgrest", shape: "path-prefix" }],
		])
	})
})

describe("reach", () => {
	it("hands the run the transport of what has one, and nothing otherwise", () => {
		const transport = (async () => new Response()) as typeof fetch
		expect(reach({ close: async () => {}, fetch: transport, url: "x" })).toEqual({ network: { fetch: transport } })
		expect(reach({ close: async () => {}, url: "x" })).toEqual({})
	})
})
