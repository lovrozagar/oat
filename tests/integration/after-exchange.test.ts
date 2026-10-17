import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client, type Exchange } from "../../src/runtime/client.ts"

/*
 * What oat learns from an answer — a record a create made — is learned before the request returns,
 * from every view alike. The callback runs once the in-flight slot is free, so a callback that
 * reads back what it saw does not wait on the slot its own request holds.
 */

let server: Server | undefined
afterEach(async () => {
	const open = server
	server = undefined
	if (open !== undefined) await new Promise<void>((resolve) => open.close(() => resolve()))
})

async function serve(): Promise<string> {
	server = createServer((req, res) => {
		if (req.url === "/broken") {
			req.socket.destroy()
			return
		}
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ path: req.url }))
	})
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("Client.setAfterExchange", () => {
	it("is awaited before the request returns, and may send its own request at maxInFlight 1", async () => {
		const client = new Client(await serve(), {}, 1)
		const seen: string[] = []
		client.setAfterExchange(async (exchange: Exchange) => {
			seen.push(new URL(exchange.url).pathname)
			if (new URL(exchange.url).pathname === "/made") await client.get("/read-back")
		})
		await client.request("POST", "/made", { body: {} })
		expect(seen).toEqual(["/made", "/read-back"])
	})

	it("fires for a view's requests, with the view's purpose", async () => {
		const client = new Client(await serve())
		const purposes: Array<string | undefined> = []
		client.setAfterExchange(async (exchange) => {
			purposes.push(exchange.purpose)
		})
		await client.view({ purpose: "probe" }).get("/a")
		await client.readOnlyView({ purpose: "assertion" }).get("/b")
		expect(purposes).toEqual(["probe", "assertion"])
	})

	it("never fires for a request that threw", async () => {
		const client = new Client(await serve())
		let calls = 0
		client.setAfterExchange(async () => {
			calls += 1
		})
		await expect(client.request("POST", "/broken", { body: {} })).rejects.toThrow()
		expect(calls).toBe(0)
	})
})
