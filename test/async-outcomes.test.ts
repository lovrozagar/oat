import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { driveAsync } from "../src/runtime/async.ts"
import { Client } from "../src/runtime/client.ts"
import type { AsyncSpec } from "../src/spec/extensions.ts"

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

describe("how polling a job ends", () => {
	it("reaches a terminal state, with poll named by operationId", async () => {
		const outcome = await driveAsync(
			new Client(url),
			spec("job.get"),
			{ id: "done" },
			{},
			() => ({}),
			undefined,
			(id) => (id === "job.get" ? { method: "get", path: "/jobs/{id}" } : undefined),
		)
		expect(outcome.state).toBe("terminal")
	})

	it("tells a job that vanished from one that never finished", async () => {
		served = 0
		const vanished = await driveAsync(new Client(url), spec("GET /jobs/{id}"), { id: "vanishing" }, {}, () => ({}))
		expect(vanished.state).toBe("vanished")
		const slow = await driveAsync(new Client(url), spec("GET /jobs/{id}", 60), { id: "slow" }, {}, () => ({}))
		expect(slow.state).toBe("timed-out")
	})

	it("says when the poll route cannot be filled, without asking", async () => {
		const outcome = await driveAsync(new Client(url), spec("GET /jobs/{id}/{part}"), {}, {}, () => ({}))
		expect(outcome.state).toBe("unfillable")
		expect(outcome.polls).toBe(0)
	})
})
