import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/*
 * The published package as a user gets it: packed, installed from the tarball into a fresh
 * consumer, its config type-checked under strict settings, and every command run through the
 * installed bin against the demo API it serves. A Postgres pass joins when PGHOST is set.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const HOME = mkdtempSync(join(tmpdir(), "oat-e2e-"))
const CONSUMER = join(HOME, "consumer")
const BIN = join(CONSUMER, "node_modules", "@lovrozagar", "oat", "bin", "oat.js")
const servers: ChildProcess[] = []

interface Ran {
	code: number | null
	out: string
}

function sh(command: string, args: string[], cwd: string): Ran {
	const ran = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } })
	return { code: ran.status, out: `${ran.stdout}${ran.stderr}` }
}

/** A setup step that must succeed, or the whole file stops with what it said. */
function must(ran: Ran, step: string): void {
	if (ran.code !== 0) throw new Error(`${step} exited ${ran.code}: ${ran.out}`)
}

const oat = (args: string[], env: Record<string, string> = {}): Ran => {
	const ran = spawnSync(process.execPath, [BIN, ...args], {
		cwd: CONSUMER,
		encoding: "utf8",
		env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
	})
	return { code: ran.status, out: `${ran.stdout}${ran.stderr}` }
}

/** `oat serve` from the installed bin, resolved with the URL it prints. */
function serve(args: string[]): Promise<string> {
	const child = spawn(process.execPath, [BIN, "serve", ...args], { cwd: CONSUMER, env: process.env })
	servers.push(child)
	return new Promise((resolve, reject) => {
		let seen = ""
		child.stderr.on("data", (chunk: Buffer) => (seen += chunk.toString()))
		child.stdout.on("data", (chunk: Buffer) => {
			seen += chunk.toString()
			const url = /url\s+(http\S+)/.exec(seen)?.[1]
			if (url !== undefined) resolve(url)
		})
		child.once("exit", (code) => reject(new Error(`oat serve exited ${code}: ${seen}`)))
	})
}

/* What a consumer writes: the demo API's jwt login per principal, from the package by name. */
const CONFIG = `import { defineConfig, env } from "@lovrozagar/oat"

export default defineConfig({
	baseUrl: env("OAT_BASE_URL"),
	principals: {
		alpha: { key: "key_alpha", scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" },
		beta: { key: "key_beta", scope: { project_id: "proj_beta" }, tenant: "proj_beta" },
	},
	security: {
		jwt: { login: { from: "$.access_token", steps: [{ body: { key: "{principal.key}" }, operationId: "auth.token" }] } },
	},
	seed: 42,
	spec: "/v1/openapi/spec",
})
`

const TSCONFIG = {
	compilerOptions: {
		exactOptionalPropertyTypes: true,
		module: "nodenext",
		moduleResolution: "nodenext",
		noEmit: true,
		noUncheckedIndexedAccess: true,
		skipLibCheck: false,
		strict: true,
		target: "es2023",
		typeRoots: [join(ROOT, "node_modules", "@types")],
		types: ["node"],
	},
	include: ["oat.config.ts"],
}

beforeAll(() => {
	const packed = sh("npm", ["pack", "--ignore-scripts", "--pack-destination", HOME], ROOT)
	must(packed, "npm pack")
	const tarball = readdirSync(HOME).find((name) => name.endsWith(".tgz"))
	if (tarball === undefined) throw new Error(`npm pack wrote no tarball: ${packed.out}`)
	mkdirSync(CONSUMER)
	const manifest = { dependencies: { "@lovrozagar/oat": `file:${join(HOME, tarball)}` }, private: true }
	writeFileSync(join(CONSUMER, "package.json"), JSON.stringify({ ...manifest, name: "consumer", type: "module" }))
	const installed = sh("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", "--ignore-scripts"], CONSUMER)
	must(installed, "npm install")
	writeFileSync(join(CONSUMER, "oat.config.ts"), CONFIG)
	writeFileSync(join(CONSUMER, "tsconfig.json"), JSON.stringify(TSCONFIG))
}, 300_000)

afterAll(() => {
	for (const server of servers) server.kill()
})

describe("the installed package", () => {
	it("type-checks a strict consumer config against its declarations", () => {
		const tsc = sh(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "."], CONSUMER)
		expect(tsc).toMatchObject({ code: 0 })
	})

	it("prints help, and refuses a command line it cannot run with exit 2", () => {
		const help = oat(["help"])
		expect(help.code).toBe(0)
		expect(help.out).toContain("oat — OpenAPI Tester")
		expect(oat(["run"]).code).toBe(2)
	})
})

describe("the installed bin against the demo API", () => {
	let memory = ""
	beforeAll(async () => {
		memory = await serve([])
	})

	it("writes a starter config with init, and reads it and the consumer's with doctor and plan", () => {
		const init = oat(["init", "--spec", `${memory}/v1/openapi/spec`, "--out", "init.config.ts"])
		expect(init).toMatchObject({ code: 0 })
		expect(readFileSync(join(CONSUMER, "init.config.ts"), "utf8")).toContain('from "@lovrozagar/oat"')
		const doctor = oat(["doctor", "--config", "oat.config.ts"], { OAT_BASE_URL: memory })
		/* 1 is doctor naming what cannot be tested; anything else is a refusal. */
		expect(doctor).toMatchObject({ code: doctor.code === 1 ? 1 : 0 })
		expect(doctor.out).toContain("jwt")
		const plan = oat(["plan", "--config", "oat.config.ts"], { OAT_BASE_URL: memory })
		expect(plan).toMatchObject({ code: 0 })
	})

	it("runs clean (exit 0), keeps a baseline, and diffs two runs", () => {
		const run = oat(["run", "--config", "oat.config.ts", "--out", "runs/clean", "--quiet"], { OAT_BASE_URL: memory })
		expect(run).toMatchObject({ code: 0 })
		const latest = join(CONSUMER, "runs", "clean", "latest")
		for (const file of ["oat-report.json", "oat-report.md", "matrix.html", "matrix.json"])
			expect(existsSync(join(latest, file)) ? file : `missing ${file}`).toBe(file)
		const report = JSON.parse(readFileSync(join(latest, "oat-report.json"), "utf8")) as { schemaVersion: number }
		expect(report.schemaVersion).toBe(1)
		const baseline = oat(["baseline", "--from", latest, "--out", "baseline.json"])
		expect(baseline).toMatchObject({ code: 0 })
		expect(existsSync(join(CONSUMER, "baseline.json"))).toBe(true)
		oat(["run", "--config", "oat.config.ts", "--out", "runs/again", "--quiet"], { OAT_BASE_URL: memory })
		const diff = oat(["diff", latest, join(CONSUMER, "runs", "again", "latest")])
		expect(diff).toMatchObject({ code: 0 })
	})
})

describe("the installed bin's verdicts and stores", () => {
	it("exits 1 on a defect, 4 on records teardown could not remove, 3 when the backend is gone", async () => {
		const leaky = await serve(["--defects", "CROSS_TENANT_READ"])
		const found = oat(["run", "--config", "oat.config.ts", "--out", "runs/defect", "--quiet"], { OAT_BASE_URL: leaky })
		expect(found).toMatchObject({ code: 1 })
		const sticky = await serve(["--defects", "DELETE_KEEPS_ROW"])
		const kept = oat(["run", "--config", "oat.config.ts", "--out", "runs/kept", "--quiet"], { OAT_BASE_URL: sticky })
		expect(kept).toMatchObject({ code: 4 })
		const gone = oat(["run", "--config", "oat.config.ts", "--out", "runs/gone", "--quiet"], {
			OAT_BASE_URL: "http://127.0.0.1:9",
		})
		expect(gone).toMatchObject({ code: 3 })
	})

	it("runs clean on the sqlite store", async () => {
		const sqlite = await serve(["--backend", "sqlite"])
		const run = oat(["run", "--config", "oat.config.ts", "--out", "runs/sqlite", "--quiet"], { OAT_BASE_URL: sqlite })
		expect(run).toMatchObject({ code: 0 })
	})

	it("asks for the optional Postgres driver with exit 2, then runs clean on Postgres once it is installed", async () => {
		const missing = oat(["serve", "--backend", "postgres"])
		expect(missing).toMatchObject({ code: 2 })
		expect(missing.out).toContain("oat: --backend postgres needs the postgres package (^3.4): npm install postgres")
		if (process.env["PGHOST"] === undefined) return
		must(
			sh("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", "postgres@^3.4"], CONSUMER),
			"npm install postgres",
		)
		const postgres = await serve(["--backend", "postgres"])
		const run = oat(["run", "--config", "oat.config.ts", "--out", "runs/postgres", "--quiet"], {
			OAT_BASE_URL: postgres,
		})
		expect(run).toMatchObject({ code: 0 })
	})

	it("runs its own conformance suites, leaving out an unreachable backend", () => {
		const conformance = oat(["conformance", "--legs", "suites", "--skip-backend", "postgres"])
		expect(conformance).toMatchObject({ code: 0 })
	})
})
