import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { main } from "../../src/cli/main.ts"
import { bufferWriter } from "../../src/cli/writer.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { referenceToken } from "../support/reference-auth.ts"

/*
 * `oat init` as a user meets it: a starter config from the reference's document, `oat doctor` on
 * that config before and after its env vars are set, then `oat run` with the reference's credentials
 * in those vars. The config imports the package as an installed one would, from a stand-in that
 * re-exports this checkout's entry point.
 */

const ENTRY = join(import.meta.dirname, "../../src/index.ts")
const SECURITY_LINES = [
	/^ {4}apiKey +apiKey +header Authorization: \{credential\} +static$/m,
	/^ {4}jwt +bearer \(JWT\) +header Authorization: Bearer \{credential\} +static$/m,
]

let server: Awaited<ReturnType<typeof createMemoryServer>>
let dir: string
let config: string
let scoped: string

beforeAll(async () => {
	server = await createMemoryServer()
	dir = await mkdtemp(join(tmpdir(), "oat-init-"))
	config = join(dir, "oat.config.ts")
	scoped = join(dir, "scoped.config.ts")
	const pkg = join(dir, "node_modules", "@lovrozagar", "oat")
	await mkdir(pkg, { recursive: true })
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ exports: "./index.ts", name: "@lovrozagar/oat", type: "module" }),
	)
	await writeFile(join(pkg, "index.ts"), `export * from ${JSON.stringify(ENTRY)}\n`)
	await writeFile(join(dir, "openapi.json"), await (await fetch(`${server.url}/v1/openapi/spec`)).text())
})

afterAll(async () => {
	vi.unstubAllEnvs()
	await server.close()
	await rm(dir, { force: true, recursive: true })
})

async function oat(...argv: string[]): Promise<{ code: number; out: string }> {
	const writer = bufferWriter()
	const code = await main(argv, { writer })
	return { code, out: writer.text() }
}

/* The reference's credentials for its first tenant's owner: a jwt, and an apiKey minted with it, as the env vars carry them. */
async function referenceCredentials(): Promise<{ apiKey: string; jwt: string }> {
	const jwt = await referenceToken(server.url, "key_alpha")
	const minted = await fetch(`${server.url}/v1/api-keys`, {
		body: JSON.stringify({ scopes: ["job:read", "job:write", "row:read", "row:write", "table:read", "table:write"] }),
		headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
		method: "POST",
	})
	if (minted.status !== 201) throw new Error(`the reference minted no apiKey: ${minted.status}`)
	return { apiKey: `ApiKey ${((await minted.json()) as { key: string }).key}`, jwt }
}

describe("oat init, then doctor and run on what it wrote", () => {
	it("writes a recipe per scheme and names every env var it reads", async () => {
		const spec = join(dir, "openapi.json")
		const written = await oat("init", "--spec", spec, "--out", config)
		expect(written).toEqual({
			code: 0,
			out: `  wrote ${config} — 2 schemes, 1 principal\n    set OAT_BASE_URL, OAT_API_KEY_KEY, OAT_JWT_TOKEN\n    next: oat doctor --config ${config}\n`,
		})
		const text = await readFile(config, "utf8")
		expect(text).toContain(`spec: ${JSON.stringify(spec)},`)
		expect(text).toContain('baseUrl: env("OAT_BASE_URL"),')
		expect(text).toContain('apiKey: { static: env("OAT_API_KEY_KEY") },')
		expect(text).toContain('jwt: { static: env("OAT_JWT_TOKEN") },')
		/* The project has no create, so init stubs it as the principal's scope, commented until filled. */
		expect(text).toContain('\t\t\t// scope: { project_id: "" },\n')
		expect(text).toMatch(/\t\t\t\/\/ project_id unlocks table\.list, .+ and \d+ more\n/)
		expect((await oat("init", "--spec", spec, "--out", config)).code).toBe(2)
	})

	it("doctor names the unset vars, then shows every scheme's recipe once they are set", async () => {
		const unset = await oat("doctor", "--config", config)
		expect(unset.out).toContain(
			"  env        OAT_BASE_URL, OAT_API_KEY_KEY, OAT_JWT_TOKEN not set — a run stops until they are\n",
		)
		for (const line of SECURITY_LINES) expect(unset.out).toMatch(line)
		const { apiKey, jwt } = await referenceCredentials()
		vi.stubEnv("OAT_BASE_URL", server.url)
		vi.stubEnv("OAT_API_KEY_KEY", apiKey)
		vi.stubEnv("OAT_JWT_TOKEN", jwt)
		const set = await oat("doctor", "--config", config)
		expect(set.out).toContain("  security — 2 schemes\n")
		for (const line of SECURITY_LINES) expect(set.out).toMatch(line)
		expect(set.out).not.toContain("not set — a run stops")
		/* Until the stub is filled the project is a root the run lacks; ids a flow yields never block. */
		expect(set.out).toContain("  roots required in config (no create operation in this document)\n    project_id\n")
		expect(set.out).toMatch(/ {2}ids no operation creates .+\n(?: {4}\w+\n)* {4}token\n/)
		expect([unset.code, set.code]).toEqual([1, 1])
		/* A new file: this process already imported the config at its own path, and keeps that module. */
		const text = await readFile(config, "utf8")
		await writeFile(scoped, text.replace('// scope: { project_id: "" },', 'scope: { project_id: "proj_alpha" },'))
		const filled = await oat("doctor", "--config", scoped)
		expect(filled.out).not.toContain("roots required in config")
		expect(filled.out).toContain(`    ${"project_id".padEnd(20)} principal scope\n`)
		expect(filled.code).toBe(0)
	})
})

/* After the describe above: the config it wrote and filled, with the vars it set. */
describe("oat run on the config init wrote and the stub filled", () => {
	it("runs against the reference with the vars set, and blames it for nothing on a correct backend", async () => {
		const ran = await oat("run", "--config", scoped, "--out", join(dir, "runs"), "--quiet")
		const reportPath = /^ {2}report: (.+)oat-report\.md$/m.exec(ran.out)?.[1]
		expect(reportPath).toBeDefined()
		const report = JSON.parse(await readFile(`${reportPath}oat-report.json`, "utf8")) as {
			findings: Array<{ check: string; detail: string; verdict: string }>
			scope: { operations: Array<{ operationId: string; status: string }> }
		}
		const status = new Map(report.scope.operations.map((op) => [op.operationId, op.status]))
		expect(["table.list", "row.create", "job.get"].map((id) => status.get(id))).toEqual(["passed", "passed", "passed"])
		/* With the stub filled, seeding reaches below the project. */
		expect(report.findings.filter((finding) => finding.detail.includes("{project_id}"))).toEqual([])
		expect(
			report.findings.filter((finding) => finding.verdict === "BACKEND_BUG" || finding.verdict === "SECURITY"),
		).toEqual([])
		expect(ran.out).not.toContain("the suite caller was logged out")
		expect(ran.out).toContain("  result: clean — no defects found in what was graded\n")
		expect(ran.code).toBe(0)
	}, 60_000)
})
