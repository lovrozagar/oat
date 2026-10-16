import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../src/runtime/client.ts"
import { MissingValueError } from "../src/runtime/missing-value.ts"
import { idOf } from "../src/runtime/world.ts"
import { FILTER_PRESETS, renderTerm } from "../src/spec/filter-render.ts"

/*
 * A record without its identity used to become the text "undefined" in a path (`GET /notes/undefined`),
 * a filter (`ID eq undefined`) or a tenant probe. A request built from a missing value says nothing
 * about the backend: the check that wanted it does not apply, and nothing is sent.
 */

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
})

async function counting(): Promise<{ url: string; hits: string[] }> {
	const hits: string[] = []
	const server = createServer((req, res) => {
		hits.push(req.url ?? "")
		res.writeHead(200, { "content-type": "application/json" }).end("{}")
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

describe("idOf", () => {
	it("reads a scalar identity as text and anything else as missing", () => {
		expect(idOf({ ID: 7 }, "ID")).toBe("7")
		expect(idOf({ ID: "a-1" }, "ID")).toBe("a-1")
		expect(idOf({ id: 7 }, "ID")).toBeUndefined()
		expect(idOf({ ID: null }, "ID")).toBeUndefined()
		expect(idOf({ ID: { nested: 1 } }, "ID")).toBeUndefined()
		expect(idOf(undefined, "ID")).toBeUndefined()
	})
})

describe("a filter term", () => {
	it("refuses a missing value instead of writing it as text", () => {
		const value = undefined as unknown as string
		expect(() => renderTerm(FILTER_PRESETS.colon, "filter", { field: "ID", op: "eq", value })).toThrow(
			MissingValueError,
		)
	})
})

describe("the client", () => {
	it("sends nothing whose path or query carries a missing value", async () => {
		const backend = await counting()
		const client = new Client(backend.url)
		await expect(client.request("GET", "/v1/notes/undefined")).rejects.toBeInstanceOf(MissingValueError)
		await expect(client.request("GET", "/v1/notes", { query: { filter: "undefined" } })).rejects.toBeInstanceOf(
			MissingValueError,
		)
		await expect(client.request("GET", "/v1/notes?ID=undefined")).rejects.toBeInstanceOf(MissingValueError)
		/* A parameter named undefined on purpose is left out, and the text `null` is a value. */
		await client.request("GET", "/v1/notes", { query: { filter: undefined, x: "null" } })
		expect(backend.hits).toEqual(["/v1/notes?x=null"])
	})
})
