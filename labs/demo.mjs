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
import { DEFECTS } from "../dist/reference/defects/table.js"
import { createMemoryServer, createPostgresServer, createSqliteServer } from "../dist/reference/http/engines.js"
import { renderJson } from "../dist/report/render/json.js"
import { renderMarkdown } from "../dist/report/render/markdown.js"
import { renderRepros } from "../dist/report/render/repro.js"
import { renderConsole } from "../dist/report/render/summary.js"
import { run } from "../dist/runtime/run/index.js"
import { allocateRunDir, publishLatest } from "../dist/runtime/runs.js"

const here = dirname(fileURLToPath(import.meta.url))

function flag(name) {
	const index = process.argv.indexOf(`--${name}`)
	if (index === -1) return undefined
	const next = process.argv[index + 1]
	return next !== undefined && !next.startsWith("--") ? next : true
}

/* A deliberately mixed bag: one of each severity, so the report shows how findings are ranked
 * rather than a wall of one kind. None breaks a foundation other checks stand on (a stale list
 * would): the checks resting on it would stand down, and a defect injected beside it would go
 * unreported. tests/integration/demo-defects.test.ts holds the demo to reporting every one. */
const DEFAULT_DEFECTS = [
	"IDEMPOTENCY_IGNORED",
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
const principals = {
	alpha: { key: "key_alpha", scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" },
	beta: { key: "key_beta", scope: { project_id: "proj_beta" }, tenant: "proj_beta" },
}

/* The reference's jwt scheme: each principal trades its key at auth.token for the token. */
const security = {
	jwt: {
		login: { from: "$.access_token", steps: [{ body: { key: "{principal.key}" }, operationId: "auth.token" }] },
	},
}

console.log(`\n  backend  ${backend}`)
console.log(`  defects  ${defects.length > 0 ? defects.join(", ") : "none — correct backend"}`)

const startedAt = new Date()
const began = performance.now()
const allocated = await allocateRunDir(resolve(here, "../.oat/runs"), startedAt)
const outDir = allocated.runDir
const result = await run({
	baseUrl: server.url,
	principals,
	security,
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
for (const script of renderRepros(result.findings, server.url, result.client.redactor)) {
	await writeFile(resolve(outDir, "repro", script.filename), script.content, { mode: 0o755 })
}
await publishLatest(allocated)

process.stdout.write(renderConsole(input))
console.log(`  report   ${resolve(outDir, "oat-report.md")}`)
console.log(`  repro    ${resolve(outDir, "repro")}/`)
console.log(`  latest   ${allocated.latest}\n`)

await server.close()
