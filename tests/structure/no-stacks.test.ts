import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type Finished, reportInput, writeReports } from "../../src/cli/commands/run-report.ts"
import type { PrincipalsConfig, SecurityConfig } from "../../src/config/types/security.ts"
import { type Hosted, inProcess, launch } from "../../src/conformance/harness/launch.ts"
import { run } from "../../src/runtime/run/index.ts"
import { REDACTED } from "../../src/security/redact.ts"

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

/* The reference's jwt login, by each principal's own key: the pair the token endpoint answers. */
const SECURITY: SecurityConfig = {
	jwt: {
		login: { from: "$.access_token", steps: [{ body: { key: "{principal.key}" }, operationId: "auth.token" }] },
		refresh: {
			from: "$.access_token",
			steps: [{ body: { refresh_token: "{credential}" }, operationId: "auth.refresh" }],
		},
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

/* Whether an exchange file holds the token endpoint's own answer. */
function tokenAnswer(text: string): boolean {
	try {
		const file = JSON.parse(text) as { operationId?: string; responseBody?: Record<string, unknown> }
		return file.operationId === "auth.token" && file.responseBody !== undefined && "access_token" in file.responseBody
	} catch {
		return false
	}
}

/*
 * The token endpoint's answer, carrying an access and a refresh token, and every such token read
 * off the wire before oat sees it. `form` re-encodes the pair as
 * `application/x-www-form-urlencoded`, as some token endpoints answer: oat reads it by its media
 * type, and journals the answer all the same.
 */
function tokenWire(server: Hosted, form: boolean): { fetch: typeof fetch; issued: Set<string> } {
	const issued = new Set<string>()
	/* An in-process server is reached through its own transport. */
	const inner = server.fetch as typeof fetch
	const watched: typeof fetch = async (input, init) => {
		const response = await inner(input, init)
		if (!String(input).endsWith("/v1/auth/token") || response.status !== 200) return response
		const body = (await response.json()) as Record<string, unknown>
		const pair = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value)]))
		pair.refresh_token ??= `rt_${pair.access_token}_refresh`
		for (const key of ["access_token", "refresh_token"]) issued.add(pair[key] as string)
		const text = form ? new URLSearchParams(pair).toString() : JSON.stringify(pair)
		const type = form ? "application/x-www-form-urlencoded" : "application/json"
		return new Response(text, { headers: { "content-type": type }, status: 200 })
	}
	return { fetch: watched, issued }
}

/** A run over the reference through `wire`, its reports written, and every file under its output directory. */
async function runThrough(server: Hosted, wire: { fetch: typeof fetch }) {
	const outDir = mkdtempSync(join(tmpdir(), "oat-no-credentials-"))
	const result = await run({
		baseUrl: server.url,
		exchangeDir: outDir,
		keepCredentials: true,
		network: { fetch: wire.fetch },
		ops: ["table.list", "table.get"],
		principals: PRINCIPALS,
		security: SECURITY,
		seed: 42,
		spec: `${server.url}/v1/openapi/spec`,
	})
	const finished: Finished = { baseUrl: server.url, durationMs: 1, outDir, result, startedAt: new Date(0) }
	await writeReports(finished, reportInput(finished))
	const files = filesUnder(outDir).map(({ path, text }) => ({ path: path.slice(outDir.length + 1), text }))
	return { files, result }
}

/** The files that hold any of `values`. */
function holding(files: Array<{ path: string; text: string }>, values: readonly string[]): string[] {
	return files.filter(({ text }) => values.some((value) => text.includes(value))).map(({ path }) => path)
}

describe("a run's output directory", () => {
	it("holds no credential value the run held, in any file it wrote", { timeout: 60_000 }, async () => {
		const server = await launch({ backend: "memory", dialect: "postgrest", via: inProcess }, {})
		const wire = tokenWire(server, false)
		try {
			const { files, result } = await runThrough(server, wire)
			const values = (result.credentials ?? []).map((credential) => credential.value)
			/* Both principals signed in before planning, so there is something to look for. */
			expect(values.length).toBeGreaterThanOrEqual(2)
			expect(files.map((file) => file.path)).toContain("principals.json")
			/* The sign-ins were journaled, answers and all: the place a token would be. */
			const journal = files.find((file) => file.path.endsWith("exchanges.jsonl"))?.text ?? ""
			expect(journal.match(/"operationId":"auth\.token"/g)?.length).toBeGreaterThanOrEqual(2)
			/* The token pair the sign-in answered is scrubbed in the file that keeps the body, by key or value. */
			const tokenFile = files.find((file) => tokenAnswer(file.text))
			const answer = JSON.parse(tokenFile?.text ?? "{}") as { responseBody?: Record<string, unknown> }
			expect(answer.responseBody?.access_token).toBe(REDACTED)
			expect(answer.responseBody?.refresh_token).toBe(REDACTED)
			/* A dedicated credential's probe principal and a derived forged value never reach a written file. */
			expect(files.filter((file) => file.text.includes("#probe-")).map((file) => file.path)).toEqual([])
			/* Every token the sign-ins answered, access and refresh alike, is absent from every file, by value. */
			expect(wire.issued.size).toBeGreaterThanOrEqual(4)
			expect(holding(files, [...values, ...wire.issued])).toEqual([])
		} finally {
			await server.close()
		}
	})

	it(
		"signs in from a token answered as a form, and holds neither token in any file it wrote",
		{ timeout: 60_000 },
		async () => {
			const server = await launch({ backend: "memory", dialect: "postgrest", via: inProcess }, {})
			const wire = tokenWire(server, true)
			try {
				const { files, result } = await runThrough(server, wire)
				/* Both principals signed in from the form, so neither is BLOCKED. */
				const values = (result.credentials ?? []).map((credential) => credential.value)
				expect(values.length).toBeGreaterThanOrEqual(2)
				expect(values.every((value) => wire.issued.has(value))).toBe(true)
				const journal = files.find((file) => file.path.endsWith("exchanges.jsonl"))?.text ?? ""
				expect(journal).toContain('"operationId":"auth.token"')
				expect(wire.issued.size).toBeGreaterThanOrEqual(4)
				expect(holding(files, [...values, ...wire.issued])).toEqual([])
			} finally {
				await server.close()
			}
		},
	)
})
