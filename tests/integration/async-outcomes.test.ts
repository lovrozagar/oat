import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { driveAsync } from "../../src/runtime/async.ts"
import { Client } from "../../src/client/client.ts"
import type { Exchange } from "../../src/runtime/exchange.ts"
import type { AsyncSpec } from "../../src/spec/extensions/async.ts"
import { Redactor } from "../../src/security/redact.ts"

let url = ""
let close = async (): Promise<void> => {}
let served = 0
beforeAll(async () => {
	const server = createServer((req, res) => {
		/* `/jobs/vanishing` is served once and then is gone; `/jobs/slow` never finishes. */
		if (req.url === "/jobs/vanishing") {
			served += 1
			res.writeHead(served === 1 ? 200 : 404, { "content-type": "application/json" })
			res.end(JSON.stringify({ status: "running" }))
			return
		}
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ status: req.url === "/jobs/done" ? "done" : "running" }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	close = () => new Promise((resolve) => server.close(() => resolve()))
})
afterAll(() => close())

const spec = (poll: string, timeoutMs = 2000): AsyncSpec =>
	({ idFrom: "$.id", poll, pollIntervalMs: 5, timeoutMs, until: "status.eq.done" }) as AsyncSpec

/* A client for a document that declares no security, and the request that began the job. */
async function started(): Promise<{ client: Client; principal: string; start: Exchange }> {
	const client = new Client({
		baseUrl: url,
		credentials: { resolve: async () => ({ kind: "anonymous" }) },
		redactor: new Redactor(),
	})
	const start = await client.request("POST", "/jobs", { as: { principal: "alpha" } })
	return { client, principal: "alpha", start }
}

describe("how polling a job ends", () => {
	it("reaches a terminal state, with poll named by operationId", async () => {
		const outcome = await driveAsync({
			...(await started()),
			spec: spec("job.get"),
			receipt: { id: "done" },
			scope: {},
			operation: (id) => (id === "job.get" ? { method: "get", path: "/jobs/{id}" } : undefined),
		})
		expect(outcome.state).toBe("terminal")
	})

	it("tells a job that vanished from one that never finished", async () => {
		served = 0
		const vanished = await driveAsync({
			...(await started()),
			spec: spec("GET /jobs/{id}"),
			receipt: { id: "vanishing" },
			scope: {},
		})
		expect(vanished.state).toBe("vanished")
		const slow = await driveAsync({
			...(await started()),
			spec: spec("GET /jobs/{id}", 60),
			receipt: { id: "slow" },
			scope: {},
		})
		expect(slow.state).toBe("timed-out")
	})

	it("says when the poll route cannot be filled, without asking", async () => {
		const outcome = await driveAsync({
			...(await started()),
			spec: spec("GET /jobs/{id}/{part}"),
			receipt: {},
			scope: {},
		})
		expect(outcome.state).toBe("unfillable")
		expect(outcome.polls).toBe(0)
	})
})
