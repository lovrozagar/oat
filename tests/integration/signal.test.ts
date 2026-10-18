import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { leftBehind } from "../../src/conformance/leaks.ts"
import { PRINCIPALS } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { ReferenceServer } from "../../src/reference/http/server.ts"

/*
 * A first Ctrl-C or SIGTERM stops testing in whatever phase the run is in — a long scenario
 * included — removes what the run created, writes the report, and exits 130 or 143. Only a second
 * signal means "now". Runs the built CLI, as a user would.
 */

const CLI = resolve(import.meta.dirname, "..", "..", "dist", "cli.js")
const servers: ReferenceServer[] = []
const proxies: Array<{ close: () => Promise<void> }> = []
const dirs: string[] = []

afterAll(async () => {
	await Promise.all(proxies.map((proxy) => proxy.close()))
	await Promise.all(servers.map((server) => server.close()))
	await Promise.all(dirs.map((dir) => rm(dir, { force: true, recursive: true })))
})

/* A scenario that polls for something that never appears keeps the run in its scenario phase. */
const SCENARIO = {
	covers: ["table.list"],
	id: "never-ready",
	steps: [
		{
			assert: { equals: "never", from: "$.never" },
			operationId: "table.list",
			poll: { everyMs: 200, within: "60s" },
		},
	],
}

/*
 * In front of the backend. Once told to hold, a DELETE is kept waiting and `held` settles: the run
 * is then still removing what it made, the moment a second signal must cut short. A timer cannot
 * find that moment: on a fast machine the stop was over within 50 ms, and a signal sent as the
 * process exits kills it before any handler can run.
 */
async function holdingProxy(target: string) {
	let holding = false
	let onHeld: () => void
	const held = new Promise<void>((settle) => {
		onHeld = settle
	})
	const waiting: ServerResponse[] = []
	const server = createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", async () => {
			if (holding && req.method === "DELETE") {
				waiting.push(res)
				onHeld()
				return
			}
			const headers = Object.fromEntries(
				Object.entries(req.headers).filter(([name]) => name !== "host" && name !== "content-length"),
			) as Record<string, string>
			const upstream = await fetch(`${target}${req.url ?? "/"}`, {
				...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
				headers,
				...(req.method === undefined ? {} : { method: req.method }),
			})
			const text = await upstream.text()
			res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain" })
			res.end(text)
		})
	})
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	const close = (): Promise<void> => {
		for (const res of waiting) res.destroy()
		server.closeAllConnections()
		return new Promise<void>((closed) => server.close(() => closed()))
	}
	return {
		close,
		held,
		hold: () => {
			holding = true
		},
		url,
	}
}

async function interrupted(signal: NodeJS.Signals, phase: string, twice = false) {
	const server = await createMemoryServer({})
	servers.push(server)
	/* A second signal goes out while the run is provably stopping: with a teardown delete held. */
	const proxy = twice ? await holdingProxy(server.url) : undefined
	if (proxy !== undefined) proxies.push(proxy)
	const base = proxy?.url ?? server.url
	const dir = await mkdtemp(join(tmpdir(), "oat-signal-"))
	dirs.push(dir)
	const config = join(dir, "oat.config.json")
	await writeFile(
		config,
		JSON.stringify({
			baseUrl: base,
			principals: PRINCIPALS,
			scenarios: [SCENARIO],
			seed: 42,
			spec: `${base}/v1/openapi/spec`,
		}),
	)
	const before = await server.snapshot()
	const child = spawn(process.execPath, ["--experimental-sqlite", CLI, "run", "--config", config, "--out", dir], {
		stdio: ["ignore", "ignore", "pipe"],
	})
	let sent = false
	let stderr = ""
	child.stderr.setEncoding("utf8")
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk
		if (!sent && stderr.includes(`phase=${phase}`)) {
			sent = true
			proxy?.hold()
			child.kill(signal)
			void proxy?.held.then(() => child.kill(signal))
		}
	})
	const code = await new Promise<number | null>((done) => child.on("close", (exit) => done(exit)))
	const after = await server.snapshot()
	return { after, before, code, dir, sent }
}

/* The run writes into a stamped directory under --out, with a `latest` link beside it. */
async function reportOf(dir: string): Promise<{ interrupted?: boolean }> {
	const stamped = (await readdir(dir)).filter((name) => /^\d/.test(name))
	const [only] = stamped
	if (only === undefined) throw new Error(`no run directory in ${dir}`)
	return JSON.parse(await readFile(join(dir, only, "oat-report.json"), "utf8")) as { interrupted?: boolean }
}

describe("a first signal", () => {
	it("stops a scenario, tears down, reports, and exits 143 on SIGTERM", async () => {
		const run = await interrupted("SIGTERM", "scenario")
		expect(run.sent).toBe(true)
		expect(run.code).toBe(143)
		expect((await reportOf(run.dir)).interrupted).toBe(true)
		expect(leftBehind(run.before, run.after)).toEqual([])
	}, 120_000)

	it("stops the checks and exits 130 on SIGINT", async () => {
		const run = await interrupted("SIGINT", "test")
		expect(run.code).toBe(130)
		expect((await reportOf(run.dir)).interrupted).toBe(true)
		expect(leftBehind(run.before, run.after)).toEqual([])
	}, 120_000)
})

describe("a second signal", () => {
	it("exits at once, without teardown", async () => {
		const run = await interrupted("SIGINT", "test", true)
		expect(run.code).toBe(130)
		expect(leftBehind(run.before, run.after)).not.toEqual([])
	}, 120_000)
})
