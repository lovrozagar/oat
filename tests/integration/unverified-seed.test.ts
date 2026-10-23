import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { oat, referenceConfig, tempDirs } from "../support/cli-run.ts"
import { readFile } from "node:fs/promises"

/*
 * A create that answers only `{ id, message }` is read back by that id. When the read misses the
 * record (an eventually consistent backend answers 404 right after the create), or the entity has
 * no item read, the cohort is the bodies oat sent: checks that work out stored values stand down,
 * and the run says so in the console and in `oat-report.json` — a note, never a finding.
 */

const dirs = tempDirs("oat-unverified-seed-")
afterAll(dirs.removeAll)

const TABLE_ITEM = /^\/v1\/projects\/[^/]+\/tables\/([^/?]+)$/

type Mode = "lagging-read" | "no-item-read"

/* The reference under ack-create, behind a proxy that misses each table on its first read, or hides the table read. */
async function proxied(mode: Mode): Promise<{ url: string; close: () => Promise<void> }> {
	const reference = await createMemoryServer({ shape: "ack-create" })
	const seen = new Set<string>()
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		void forward({ mode, seen, target: reference.url }, request, response)
	})
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	return {
		close: async () => {
			await new Promise<void>((done) => server.close(() => done()))
			await reference.close()
		},
		url,
	}
}

async function forward(
	{ mode, seen, target }: { mode: Mode; seen: Set<string>; target: string },
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const path = request.url ?? "/"
	const item = TABLE_ITEM.exec(path)?.[1]
	if (mode === "lagging-read" && request.method === "GET" && item !== undefined && !seen.has(item)) {
		seen.add(item)
		response.writeHead(404, { "content-type": "application/json" })
		response.end(JSON.stringify({ error_key: "not_found", message: "not yet", status: 404, success: false }))
		return
	}
	const chunks: Buffer[] = []
	for await (const chunk of request) chunks.push(chunk as Buffer)
	const headers = Object.fromEntries(
		Object.entries(request.headers).filter(([name]) => name !== "host" && name !== "content-length"),
	) as Record<string, string>
	const answer = await fetch(`${target}${path}`, {
		...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
		headers,
		method: request.method ?? "GET",
	})
	let body = Buffer.from(await answer.arrayBuffer())
	if (mode === "no-item-read" && path.endsWith("/openapi/spec")) {
		const doc = JSON.parse(body.toString("utf8")) as { paths: Record<string, Record<string, unknown>> }
		delete doc.paths["/v1/projects/{project_id}/tables/{table_id}"]?.["get"]
		body = Buffer.from(JSON.stringify(doc))
	}
	const type = answer.headers.get("content-type")
	response.writeHead(answer.status, type === null ? {} : { "content-type": type })
	response.end(body)
}

async function runBehind(mode: Mode): Promise<{ text: string; observed: Array<Record<string, string>> }> {
	const api = await proxied(mode)
	try {
		const dir = await dirs.make()
		const config = await referenceConfig(dir, api.url)
		const runs = join(dir, "runs")
		const { out } = await oat(["run", "--config", config, "--out", runs, "--quiet", "--only", "table"])
		const report = JSON.parse(await readFile(join(runs, "latest", "oat-report.json"), "utf8")) as {
			observed: Array<Record<string, string>>
		}
		return { observed: report.observed, text: out }
	} finally {
		await api.close()
	}
}

describe("a seed oat could not read back", () => {
	it("notes a read back that answered 404, in the console and the JSON report", async () => {
		const { observed, text } = await runBehind("lagging-read")
		expect(text).toMatch(/note: table — seeded with the bodies oat sent, unverified \(read back answered 404\)/)
		expect(observed).toContainEqual(
			expect.objectContaining({
				check: "world.seed",
				entity: "table",
				note: expect.stringContaining("read back answered 404"),
			}),
		)
	}, 120_000)

	it("notes an entity with no item read", async () => {
		const { observed, text } = await runBehind("no-item-read")
		expect(text).toMatch(/note: table — seeded with the bodies oat sent, unverified \(no item read\)/)
		expect(observed).toContainEqual(
			expect.objectContaining({ check: "world.seed", entity: "table", note: expect.stringContaining("no item read") }),
		)
	}, 120_000)
})
