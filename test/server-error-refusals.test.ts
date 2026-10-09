import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { run } from "../src/runtime/run.ts"

/* A refusal the backend should answer with 409 or 404 that crashes instead is a defect, not an
 * unanswered question. A proxy turns the reference backend's refusals into 500s. */
async function crashingProxy(target: string, crashes: (method: string, status: number) => boolean) {
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", async () => {
			const headers = Object.fromEntries(
				Object.entries(req.headers).filter(([name]) => name !== "host" && name !== "content-length"),
			) as Record<string, string>
			const body = chunks.length === 0 ? undefined : Buffer.concat(chunks)
			const upstream = await fetch(`${target}${req.url ?? "/"}`, { body, headers, method: req.method })
			const text = await upstream.text()
			if (crashes(req.method ?? "GET", upstream.status)) {
				res.writeHead(500, { "content-type": "application/json" }).end('{"error":"internal"}')
				return
			}
			res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain" })
			res.end(text)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	return { close: () => new Promise<void>((resolve) => server.close(() => resolve())), url }
}

async function summaries(crashes: (method: string, status: number) => boolean): Promise<Map<string, string[]>> {
	const backend = await createMemoryServer()
	const proxy = await crashingProxy(backend.url, crashes)
	try {
		const result = await run({
			baseUrl: proxy.url,
			only: ["table"],
			principals: PRINCIPALS,
			seed: 42,
			spec: `${proxy.url}/v1/openapi/spec`,
		})
		const out = new Map<string, string[]>()
		for (const finding of result.findings) out.set(finding.check, [...(out.get(finding.check) ?? []), finding.summary])
		return out
	} finally {
		await proxy.close()
		await backend.close()
	}
}

describe("a refusal answered with a server error", () => {
	it("is a finding for a duplicate unique-set write", async () => {
		const found = await summaries((_method, status) => status === 409)
		expect(found.get("create.unique-conflict-rejected")).toContain("a duplicate unique-set create drew a server error")
		expect(found.get("update.unique-conflict-rejected")).toContain("a duplicate unique-set update drew a server error")
	}, 120_000)

	it("is a finding for deleting an absent record", async () => {
		const found = await summaries((method, status) => method === "DELETE" && status === 404)
		expect(found.get("delete.absent-record-returns-404")).toContain("deleting a nonexistent record crashes")
	}, 120_000)
})
