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
