import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { main } from "../../src/cli/main.ts"
import { isKnownFlag, parseArgs, unknownFlag, USAGE } from "../../src/cli/flags.ts"
import { PRINCIPALS } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { ReferenceServer } from "../../src/reference/http/server.ts"

describe("CLI flags", () => {
	it("does not advertise --concurrency in help", () => {
		expect(USAGE).not.toContain("--concurrency")
		expect(USAGE).toContain("--max-in-flight")
		expect(USAGE).toContain("./.oat/runs")
	})

	it("treats --concurrency as unknown (exit 2)", async () => {
		const { flags } = parseArgs(["run", "--config", "oat.config.ts", "--concurrency", "1"])
		expect(unknownFlag(flags)).toBe("concurrency")
		expect(isKnownFlag("concurrency")).toBe(false)
		const argv = process.argv
		process.argv = ["node", "oat", "run", "--concurrency", "1"]
		try {
			expect(await main()).toBe(2)
		} finally {
			process.argv = argv
		}
	})

	it("still accepts --max-in-flight", () => {
		const { flags } = parseArgs(["run", "--config", "oat.config.ts", "--max-in-flight", "8"])
		expect(unknownFlag(flags)).toBeUndefined()
		expect(flags["max-in-flight"]).toBe("8")
	})

	it("accepts --save-exchanges and --no-save-exchanges", () => {
		expect(USAGE).toContain("--save-exchanges")
		expect(USAGE).toContain("--no-save-exchanges")
		const on = parseArgs(["run", "--config", "oat.config.ts", "--save-exchanges"])
		expect(unknownFlag(on.flags)).toBeUndefined()
		expect(on.flags["save-exchanges"]).toBe(true)
		const off = parseArgs(["run", "--config", "oat.config.ts", "--no-save-exchanges"])
		expect(unknownFlag(off.flags)).toBeUndefined()
		expect(off.flags["no-save-exchanges"]).toBe(true)
	})
})

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
	const saved = process.argv
	const chunks: string[] = []
	const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		chunks.push(String(chunk))
		return true
	})
	const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		chunks.push(String(chunk))
		return true
	})
	process.argv = ["node", "oat", ...argv]
	try {
		return { code: await main(), out: chunks.join("") }
	} finally {
		process.argv = saved
		write.mockRestore()
		err.mockRestore()
	}
}

describe("--ops on the CLI", () => {
	let server: ReferenceServer
	let dir: string

	beforeAll(async () => {
		server = await createMemoryServer()
		dir = await mkdtemp(join(tmpdir(), "oat-ops-"))
	})
	afterAll(async () => {
		await server.close()
		await rm(dir, { force: true, recursive: true })
	})

	async function config(extra: Record<string, unknown> = {}): Promise<string> {
		const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`)
		const body = {
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...extra,
		}
		await writeFile(path, JSON.stringify(body))
		return path
	}

	it("advertises --ops", () => {
		expect(isKnownFlag("ops")).toBe(true)
		expect(USAGE).toContain("--ops")
	})

	it("exits 2 on a target that matches no operation", async () => {
		const { code, out } = await cli([
			"run",
			"--config",
			await config(),
			"--ops",
			"table.craete",
			"--out",
			dir,
			"--quiet",
		])
		expect(code).toBe(2)
		expect(out).toContain("Did you mean: table.create")
	})

	it("exits 0 when every target passed", async () => {
		const { code, out } = await cli(["run", "--config", await config(), "--ops", "table.get", "--out", dir, "--quiet"])
		expect(code).toBe(0)
		expect(out).toContain("scope: targeted")
		expect(out).toMatch(/table\.get\s+passed/)
	})

	it("exits 3 when a target was not graded, and reads targets from config", async () => {
		/* One read keyed by an id nothing in the document produces: oat can call nothing for it. */
		const document = {
			info: { title: "unreachable", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/v1/things/{thing_id}": {
					get: {
						operationId: "thing.get",
						parameters: [{ in: "path", name: "thing_id", required: true, schema: { type: "string" } }],
						responses: { "200": { description: "ok" } },
					},
				},
			},
		}
		const lone = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(document))
		})
		await new Promise<void>((resolve) => lone.listen(0, "127.0.0.1", resolve))
		const url = `http://127.0.0.1:${(lone.address() as AddressInfo).port}`
		try {
			const path = await config({
				baseUrl: url,
				ops: ["thing.get"],
				principals: [{ headers: { authorization: "Bearer alpha" }, id: "alpha" }],
				spec: `${url}/openapi.json`,
			})
			const { code, out } = await cli(["run", "--config", path, "--out", dir, "--quiet"])
			expect(code).toBe(3)
			expect(out).toMatch(/thing\.get\s+untested/)
		} finally {
			await new Promise<void>((resolve) => lone.close(() => resolve()))
		}
	})

	it("plan --ops prints the scope without a run", async () => {
		const { code, out } = await cli(["plan", "--spec", `${server.url}/v1/openapi/spec`, "--ops", "table.get", "--json"])
		expect(code).toBe(0)
		const scope = (
			JSON.parse(out) as {
				scope: {
					mode: string
					targets: Array<{ operationId: string; entity: string; checks: string[] }>
					entities: string[]
					support: string[]
				}
			}
		).scope
		expect(scope.mode).toBe("targeted")
		expect(scope.entities).toEqual(["row", "table"])
		expect(scope.targets[0]?.operationId).toBe("table.get")
		expect(scope.targets[0]?.checks).toContain("tenant.item-not-readable-cross-tenant")
		expect(scope.support).toContain("table.create")
	})

	it("plan --ops renders text", async () => {
		const { code, out } = await cli([
			"plan",
			"--spec",
			`${server.url}/v1/openapi/spec`,
			"--ops",
			"table.get,auth.token",
		])
		expect(code).toBe(0)
		expect(out).toContain("scope: targeted (--ops table.get,auth.token)")
		expect(out).toMatch(/auth\.token\s+unmodeled/)
	})
})

describe("one flag table", () => {
	it("takes --flag=value as well as --flag value", () => {
		expect(parseArgs(["run", "--config=oat.config.ts", "--seed=7"]).flags).toEqual({
			config: "oat.config.ts",
			seed: "7",
		})
	})

	it("refuses a value flag left without its value, or followed by another flag", () => {
		expect(parseArgs(["run", "--config"]).error).toBe("--config needs a value")
		expect(parseArgs(["run", "--config", "--quiet"]).error).toBe("--config needs a value")
	})

	it("refuses numbers that are not numbers of the right kind", () => {
		expect(parseArgs(["run", "--max-in-flight", "-1"]).error).toMatch(/positive integer/)
		expect(parseArgs(["run", "--max-in-flight", "0"]).error).toMatch(/positive integer/)
		expect(parseArgs(["run", "--seed", "abc"]).error).toMatch(/integer, got "abc"/)
		expect(parseArgs(["run", "--seed", "-3"]).error).toBeUndefined()
	})

	it("lets a switch stand alone, and reads `oat --help` as help", () => {
		expect(parseArgs(["conformance", "--fuzz"]).flags.fuzz).toBe(true)
		expect(parseArgs(["run", "--quiet=yes"]).error).toBe("--quiet takes no value")
		expect(parseArgs(["--help"])).toEqual({ command: "help", flags: { help: true } })
		expect(isKnownFlag("defects")).toBe(true)
	})
})
