import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type Finished, reportInput, writeReports } from "../../src/cli/commands/run-report.ts"
import type { PrincipalsConfig, SecurityConfig } from "../../src/config/types/security.ts"
import { inProcess, launch, reach } from "../../src/conformance/harness/launch.ts"
import { run } from "../../src/runtime/run/index.ts"

/*
 * A report is shared beyond the machine that ran it: it holds no stack frame, no absolute path and
 * no credential. Every report golden is one, so none may match; and no file a run writes under its
 * output directory holds a value the run signed in with.
 */

const ROOT = join(import.meta.dirname, "..", "..")
const LEAK = /\n\s+at |\/home\/|\/Users\/|[A-Z]:\\\\/

function snapshots(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".snap"))
		.map((entry) => join(entry.parentPath, entry.name))
}

describe("reports", () => {
	it("hold no stack frame and no absolute path", () => {
		const files = snapshots("tests/regression/__snapshots__")
		expect(files.length).toBeGreaterThan(100)
		const leaking = files.filter((file) => LEAK.test(readFileSync(file, "utf8")))
		expect(leaking.map((file) => file.slice(ROOT.length + 1))).toEqual([])
	})

	it("catch the leaks they are meant to", () => {
		expect(LEAK.test("TypeError: boom\n    at run (/srv/oat/x.js:1:1)")).toBe(true)
		expect(LEAK.test("open '/home/someone/spec.yaml'")).toBe(true)
		expect(LEAK.test("open 'C:\\\\Users\\\\spec.yaml'")).toBe(true)
		expect(LEAK.test("http://reference.test/v1/notes")).toBe(false)
	})
})

/* The reference's bearer login, by each principal's own key. */
const SECURITY: SecurityConfig = {
	bearer: {
		login: { from: "$.access_token", steps: [{ body: { key: "{principal.key}" }, operationId: "auth.token" }] },
	},
}
const PRINCIPALS: PrincipalsConfig = {
	alpha: { key: "key_alpha", rank: 2, scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" },
	beta: { inviteAs: "key_beta", key: "key_beta", rank: 2, scope: { project_id: "proj_beta" }, tenant: "proj_beta" },
}

/** Every file under `dir`, as text. */
function filesUnder(dir: string): Array<{ path: string; text: string }> {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.map((path) => ({ path, text: readFileSync(path, "latin1") }))
}

describe("a run's output directory", () => {
	it("holds no credential value the run held, in any file it wrote", { timeout: 60_000 }, async () => {
		const server = await launch({ backend: "memory", dialect: "postgrest", via: inProcess }, {})
		const outDir = mkdtempSync(join(tmpdir(), "oat-no-credentials-"))
		try {
			const result = await run({
				baseUrl: server.url,
				exchangeDir: outDir,
				keepCredentials: true,
				ops: ["table.list", "table.get"],
				principals: PRINCIPALS,
				security: SECURITY,
				seed: 42,
				...reach(server),
				spec: `${server.url}/v1/openapi/spec`,
			})
			const finished: Finished = { baseUrl: server.url, durationMs: 1, outDir, result, startedAt: new Date(0) }
			await writeReports(finished, reportInput(finished))
			const values = (result.credentials ?? []).map((credential) => credential.value)
			/* Both principals signed in before planning, so there is something to look for. */
			expect(values.length).toBeGreaterThanOrEqual(2)
			const files = filesUnder(outDir)
			expect(files.map((file) => file.path.slice(outDir.length + 1))).toContain("principals.json")
			/* The sign-ins were journaled, answers and all: the place a token would be. */
			const journal = files.find((file) => file.path.endsWith("exchanges.jsonl"))?.text ?? ""
			expect(journal.match(/"operationId":"auth\.token"/g)?.length).toBeGreaterThanOrEqual(2)
			const leaking = files.flatMap(({ path, text }) =>
				values.filter((value) => text.includes(value)).map(() => path.slice(outDir.length + 1)),
			)
			expect(leaking).toEqual([])
		} finally {
			await server.close()
		}
	})
})
