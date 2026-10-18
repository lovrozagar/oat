import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"
import { main } from "../../src/cli/main.ts"
import { PRINCIPALS } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer, createSqliteServer } from "../../src/reference/http/engines.ts"
import type { ReferenceOptions } from "../../src/reference/http/state.ts"

/* What a concurrent run cannot hold still: wall-clock times, call order and counts, request ids,
 * which later exchange happened to prove a write, and evidence bodies, which carry the server's
 * clock and per-run nonces. The evidence keeps its method, URL and status. */
const UNSTABLE_KEYS = new Set([
	"at",
	"call",
	"durationMs",
	"generatedAt",
	"latency",
	"ms",
	"observation",
	"requestBody",
	"requestBytes",
	"requestId",
	"requests",
	"responseBody",
	"responseBytes",
	"seq",
	"updatedAt",
])

/**
 * Stable text for a value that names a port, a record id, a probe nonce, an invite token or grant
 * id the reference server draws at random, a reading of the server's clock (which advances per
 * write, so concurrent lanes move it), how many polls fit in a wait, or an opaque cursor (which
 * encodes whichever record id a lane reached).
 */
export function normalizeText(text: string): string {
	return text
		.replaceAll(/http:\/\/127\.0\.0\.1:\d+/g, "http://reference.test")
		.replaceAll(/(?<![A-Za-z])([a-z]+)_\d{6}\b/g, "$1_ID")
		.replaceAll(/(?<![A-Za-z])inv_[a-z0-9]{1,10}\b/g, "inv_TOKEN")
		.replaceAll(/(?<![A-Za-z])grn_[a-z0-9]+_[a-z0-9]{6}\b/g, "grn_ID")
		.replaceAll(/\boat-([a-z]+)-[a-z0-9]{5,}\b/g, "oat-$1-NONCE")
		.replaceAll(/\b1700000\d{6}\b/g, "CLOCK")
		.replaceAll(/\b\d+ (time|poll)\(s\)/g, "N $1(s)")
		.replaceAll(/\b\d+ms\b/g, "Nms")
		.replaceAll(/([?&]cursor=)[\w-]+=*/g, "$1CURSOR")
}

/**
 * A report with the run-to-run noise removed, so a diff is a behavior change. Lanes run
 * concurrently, so list order is not behavior: every list is sorted by its canonical text.
 */
export function normalize(value: unknown): unknown {
	if (typeof value === "string") return normalizeText(value)
	if (Array.isArray(value)) {
		return value
			.map(normalize)
			.map((item) => [JSON.stringify(item), item] as const)
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([, item]) => item)
	}
	if (value === null || typeof value !== "object") return value
	const out: Record<string, unknown> = {}
	for (const [key, inner] of Object.entries(value)) {
		if (UNSTABLE_KEYS.has(key)) continue
		/* Integer ids are drawn per create, in whatever order concurrent lanes create. */
		out[key] = key === "id" && typeof inner === "string" && /^\d+$/.test(inner) ? "ID" : normalize(inner)
	}
	return out
}

export interface GoldenRun {
	code: number
	/** What the command wrote to stdout and stderr, in order. */
	output: string
	outDir: string
	read: (file: string) => Promise<string>
}

/** `oat <argv>` in-process, with its exit code and everything it printed. */
export async function runCli(argv: readonly string[]): Promise<{ code: number; output: string }> {
	const chunks: string[] = []
	const capture = (chunk: string | Uint8Array): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
		return true
	}
	const out = vi.spyOn(process.stdout, "write").mockImplementation(capture)
	const err = vi.spyOn(process.stderr, "write").mockImplementation(capture)
	const saved = process.argv
	process.argv = ["node", "oat", ...argv]
	try {
		return { code: await main(), output: chunks.join("") }
	} finally {
		process.argv = saved
		out.mockRestore()
		err.mockRestore()
	}
}

export interface GoldenTarget extends ReferenceOptions {
	/** The SQL-only defects need a store with physical column names. */
	backend?: "memory" | "sqlite"
}

/**
 * One `oat run` through the CLI against a fresh reference server, the way a user runs it: config
 * file, `--out`, the report files on disk.
 */
export async function goldenRun(target: GoldenTarget, extraFlags: readonly string[] = []): Promise<GoldenRun> {
	const { backend, ...options } = target
	const server = await (backend === "sqlite" ? createSqliteServer(options) : createMemoryServer(options))
	const dir = await mkdtemp(join(tmpdir(), "oat-golden-"))
	const config = join(dir, "oat.config.json")
	await writeFile(
		config,
		JSON.stringify({ baseUrl: server.url, principals: PRINCIPALS, seed: 42, spec: `${server.url}/v1/openapi/spec` }),
	)
	try {
		const { code, output } = await runCli([
			"run",
			"--config",
			config,
			"--out",
			join(dir, "out"),
			"--quiet",
			...extraFlags,
		])
		const outDir = join(dir, "out", "latest")
		return { code, output, outDir, read: (file) => readFile(join(outDir, file), "utf8") }
	} finally {
		await server.close()
	}
}

export async function removeRun(run: GoldenRun): Promise<void> {
	await rm(join(run.outDir, "..", ".."), { force: true, recursive: true })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * What `after` changed relative to `before`, both normalized: lists (sorted sets after
 * `normalize`) as the items added and removed, records key by key, anything else as was/now.
 * Undefined when nothing changed.
 */
export function delta(before: unknown, after: unknown): unknown {
	if (JSON.stringify(before) === JSON.stringify(after)) return undefined
	if (Array.isArray(before) && Array.isArray(after)) {
		const was = new Set(before.map((item) => JSON.stringify(item)))
		const now = new Set(after.map((item) => JSON.stringify(item)))
		const added = after.filter((item) => !was.has(JSON.stringify(item)))
		const removed = before.filter((item) => !now.has(JSON.stringify(item)))
		return { ...(added.length === 0 ? {} : { added }), ...(removed.length === 0 ? {} : { removed }) }
	}
	if (isRecord(before) && isRecord(after)) {
		const out: Record<string, unknown> = {}
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			const change = delta(before[key], after[key])
			if (change !== undefined) out[key] = change
		}
		return out
	}
	return { now: after ?? null, was: before ?? null }
}
