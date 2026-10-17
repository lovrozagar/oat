import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { type GoldenRun, goldenRun, normalizeText, removeRun } from "../support/golden.ts"

vi.mock("node:crypto", async (original) => ({
	...(await original<typeof import("node:crypto")>()),
	randomBytes: (size: number) => Buffer.alloc(size, 0xa7),
}))

interface JournalLine {
	file: string
	method: string
	operationId?: string
	status: number
	url: string
}

/* A request's shape without its values: the path with ids and nonces replaced, the query's keys. */
function shape(url: string): string {
	const parsed = new URL(normalizeText(url))
	const keys = [...new Set(parsed.searchParams.keys())].toSorted()
	return keys.length === 0 ? parsed.pathname : `${parsed.pathname}?${keys.join("&")}`
}

let run: GoldenRun
beforeAll(async () => {
	run = await goldenRun({}, ["--save-exchanges"])
})
afterAll(async () => {
	await removeRun(run)
})

describe("golden exchanges", () => {
	/* What each operation sent and got back on a clean run: the method, the URL shape, the request
	 * header names (where credentials go) and the status. Counts vary with lane timing; the set of
	 * distinct exchanges does not. */
	it("each operation's distinct exchanges on a clean run", async () => {
		const lines = (await run.read("exchanges.jsonl"))
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as JournalLine)
		const byOperation = new Map<string, Set<string>>()
		for (const line of lines) {
			const saved = JSON.parse(await readFile(join(run.outDir, line.file), "utf8")) as {
				requestHeaders?: Record<string, string>
			}
			const headers = Object.keys(saved.requestHeaders ?? {}).toSorted()
			const entry = `${line.method} ${shape(line.url)} [${headers.join(",")}] → ${line.status}`
			const operation = line.operationId ?? "(none)"
			byOperation.set(operation, (byOperation.get(operation) ?? new Set()).add(entry))
		}
		const golden = Object.fromEntries(
			[...byOperation.entries()]
				.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([operation, entries]) => [operation, [...entries].toSorted()]),
		)
		await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot("__snapshots__/exchanges.snap")
	})
})
