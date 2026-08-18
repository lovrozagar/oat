/**
 * Self-contained demo — no credentials, no external service, nothing to configure.
 *
 * Boots the reference backend with a handful of deliberate defects, points oat at it, and writes
 * a full report. This is the fastest way to see what oat actually produces before wiring it to
 * anything of your own.
 *
 *   node labs/demo.mjs                  # a few defects, see the report
 *   node labs/demo.mjs --clean          # a correct backend — should find nothing
 *   node labs/demo.mjs --defects A,B    # pick your own, names are in DEFECTS below
 *   node --experimental-sqlite labs/demo.mjs --backend sqlite
 *
 * The backend is a test fixture that ships with the repo, not part of the published package —
 * oat itself never talks to a database, only to HTTP.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFECTS } from "../dist/reference/defects.js"
import { createMemoryServer, createPostgresServer, createSqliteServer } from "../dist/reference/http.js"
import { renderConsole, renderJson, renderMarkdown, renderRepros } from "../dist/report/render.js"
import { run } from "../dist/runtime/run.js"
import { allocateRunDir } from "../dist/runtime/runs.js"

const here = dirname(fileURLToPath(import.meta.url))

function flag(name) {
	const index = process.argv.indexOf(`--${name}`)
	if (index === -1) return undefined
	const next = process.argv[index + 1]
	return next !== undefined && !next.startsWith("--") ? next : true
}

/* A deliberately mixed bag: one of each severity, so the report shows how findings are ranked
 * rather than a wall of one kind. */
const DEFAULT_DEFECTS = [
	"STALE_LIST",
	"PATCH_REPLACES",
	"TENANT_LEAK_VIA_FILTER",
	"CREATED_201_AS_200",
	"SELECT_IGNORED",
]

const defects =
	flag("clean") === true ? [] : typeof flag("defects") === "string" ? flag("defects").split(",") : DEFAULT_DEFECTS

for (const name of defects) {
	if (!Object.hasOwn(DEFECTS, name)) {
		console.error(`unknown defect "${name}". Available:\n  ${Object.keys(DEFECTS).join("\n  ")}`)
		process.exit(2)
	}
}

const backend = flag("backend") ?? "memory"
const createServer =
	backend === "memory" ? createMemoryServer : backend === "sqlite" ? createSqliteServer : createPostgresServer

const server = await createServer({ defects })

/* Two principals in different tenants — the second is what makes the isolation checks possible. */
const principals = [
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_alpha" }, operationId: "auth.token" }],
		},
		id: "alpha",
		roots: { project_id: "proj_alpha" },
	},
	{
		auth: {
			credentialFrom: "$.access_token",
			steps: [{ body: { key: "key_beta" }, operationId: "auth.token" }],
		},
		id: "beta",
		roots: { project_id: "proj_beta" },
	},
]

console.log(`\n  backend  ${backend}`)
console.log(`  defects  ${defects.length > 0 ? defects.join(", ") : "none — correct backend"}`)

const startedAt = new Date()
const began = performance.now()
const { latest, runDir: outDir } = await allocateRunDir(resolve(here, "../.oat/runs"), startedAt)
const result = await run({
	baseUrl: server.url,
	principals,
	seed: 42,
	spec: `${server.url}/v1/openapi/spec`,
})
const durationMs = performance.now() - began

const input = {
	baseUrl: server.url,
	checksRun: result.checksRun,
	client: result.client,
	durationMs,
	entitiesTested: result.entitiesTested,
	findings: result.findings,
	model: result.model,
	startedAt,
}

await mkdir(resolve(outDir, "repro"), { recursive: true })
await writeFile(resolve(outDir, "oat-report.md"), renderMarkdown(input))
await writeFile(resolve(outDir, "oat-report.json"), renderJson(input))
for (const script of renderRepros(result.findings, server.url)) {
	await writeFile(resolve(outDir, "repro", script.filename), script.content, { mode: 0o755 })
}

process.stdout.write(renderConsole(input))
console.log(`  report   ${resolve(outDir, "oat-report.md")}`)
console.log(`  repro    ${resolve(outDir, "repro")}/`)
console.log(`  latest   ${latest}\n`)

await server.close()
