import { describe, expect, it } from "vitest"
import { Client } from "./client.ts"

/*
 * Read-only checks run together, through a client that cannot write: one that changed server
 * state would move the cohort under every other check in its batch.
 */

describe("a read-only client", () => {
	it("refuses to send anything that could change server state", async () => {
		const client = new Client("http://127.0.0.1:9").readOnlyView({ check: "sort.order-is-applied" })
		const unsafe = client as unknown as Client
		await expect(unsafe.request("POST", "/rows")).rejects.toThrow(/does not mutate/)
		await expect(unsafe.view({ purpose: "probe" }).request("DELETE", "/rows/1")).rejects.toThrow(/does not mutate/)
	})
})

describe("a client's transport", () => {
	it("sends through the fetch it was given, and records what came back", async () => {
		const seen: string[] = []
		const transport: typeof fetch = async (input, init) => {
			seen.push(`${init?.method ?? "GET"} ${String(input)}`)
			return new Response(JSON.stringify([{ id: "a" }]), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		}
		const client = new Client("http://api.test", {}, 4, undefined, undefined, undefined, { fetchImpl: transport })
		const exchange = await client.get("/rows")
		expect(seen).toEqual(["GET http://api.test/rows"])
		expect(exchange.status).toBe(200)
		expect(exchange.responseBody).toEqual([{ id: "a" }])
		expect(client.transcript).toHaveLength(1)
	})
})
