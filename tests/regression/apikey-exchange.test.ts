import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { SecurityConfig } from "../../src/config/types/security.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { Exchange } from "../../src/runtime/exchange.ts"
import { run } from "../../src/runtime/run/index.ts"
import { normalizeText } from "../support/golden.ts"

vi.mock("node:crypto", async (original) => ({
	...(await original<typeof import("node:crypto")>()),
	randomBytes: (size: number) => Buffer.alloc(size, 0xa7),
}))

/*
 * Bar 1, end to end: the reference behind a socket, and a principal whose API key comes from the
 * apiKey mint recipe alone, minted with its jwt and sent as `ApiKey <key>`. An entity read the
 * document secures with jwt OR a scoped key, sent with the key, must carry that one scheme's
 * credential and nothing else; the journal keeps the header with its value redacted.
 */
const SECURITY: SecurityConfig = {
	apiKey: {
		format: "ApiKey {credential}",
		mint: {
			body: { scopes: "{scopes}" },
			from: "$.key",
			operationId: "apiKey.create",
			revoke: "apiKey.revoke",
			with: "jwt",
		},
	},
	jwt: { login: { from: "$.access_token", steps: [{ body: { key: "{principal.key}" }, operationId: "auth.token" }] } },
}

/** A read of a record or a list, the entity routes an API key may take. */
const ENTITY_READ = /\.(get|list)$/

/* A request's shape without its values: the path with ids and nonces replaced, the query's keys. */
function shape(url: string): string {
	const parsed = new URL(normalizeText(url))
	const keys = [...new Set(parsed.searchParams.keys())].toSorted()
	return keys.length === 0 ? parsed.pathname : `${parsed.pathname}?${keys.join("&")}`
}

let dir: string
let reads: Exchange[]
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "oat-apikey-"))
	const server = await createMemoryServer()
	try {
		const result = await run({
			baseUrl: server.url,
			exchangeDir: dir,
			principals: { alpha: { key: "key_alpha", rank: 2, scope: { project_id: "proj_alpha" }, tenant: "proj_alpha" } },
			security: SECURITY,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		reads = result.client.transcript.filter(
			(exchange) =>
				exchange.method === "GET" &&
				ENTITY_READ.test(exchange.operationId ?? "") &&
				JSON.stringify(exchange.schemes) === JSON.stringify(["apiKey"]),
		)
	} finally {
		await server.close()
	}
}, 120_000)
afterAll(async () => {
	await rm(dir, { force: true, recursive: true })
})

describe("an apiKey-alternative entity read, end to end", () => {
	it("carries the apiKey scheme alone, its value redacted in the journal", async () => {
		/* The journal names each exchange's file by its line, not by its seq. */
		const files = new Map(
			(await readFile(join(dir, "exchanges.jsonl"), "utf8"))
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as { seq: number; file: string })
				.map((line) => [line.seq, line.file] as const),
		)
		const golden = new Map<string, Set<string>>()
		for (const exchange of reads) {
			const saved = JSON.parse(await readFile(join(dir, files.get(exchange.seq) as string), "utf8")) as {
				requestHeaders: Record<string, string>
			}
			const headers = Object.entries(saved.requestHeaders)
				.map(([name, value]) => `${name}: ${normalizeText(value)}`)
				.toSorted()
			const entry = `${exchange.method} ${shape(exchange.url)} schemes=${JSON.stringify(exchange.schemes)} [${headers.join(", ")}] → ${exchange.status}`
			const operation = exchange.operationId as string
			golden.set(operation, (golden.get(operation) ?? new Set()).add(entry))
		}
		const sorted = Object.fromEntries(
			[...golden.entries()]
				.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([operation, entries]) => [operation, [...entries].toSorted()]),
		)
		expect(Object.keys(sorted).length).toBeGreaterThan(0)
		await expect(`${JSON.stringify(sorted, null, 2)}\n`).toMatchFileSnapshot("__snapshots__/apikey-exchange.snap")
	})
})
