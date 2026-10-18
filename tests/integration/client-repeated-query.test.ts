import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import { toCurl } from "../../src/client/curl.ts"
import { mergeQuery } from "../../src/runtime/query.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * Some grammars write one filter term per parameter and repeat the parameter for each term:
 * `?filter=and_Qty_eq_2&filter=and_Name_eq_x`. The client must send every occurrence, in order,
 * and everything that shows the request afterwards must show it as sent.
 */

let url = ""
let close: () => Promise<void> = async () => {}
const seen: string[] = []

beforeAll(async () => {
	const server = createServer((req, res) => {
		seen.push(req.url ?? "")
		res.writeHead(200, { "content-type": "application/json" })
		res.end("[]")
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	close = () => new Promise((resolve) => server.close(() => resolve()))
})
afterAll(() => close())

describe("repeated query parameters", () => {
	it("sends every value of an array, in order, next to scalar parameters", async () => {
		const exchange = await new Client({ baseUrl: url, redactor: new Redactor() }).get("/notes", {
			query: { f: ["a", "b"], g: "c", n: 3 },
		})
		expect(seen.at(-1)).toBe("/notes?f=a&f=b&g=c&n=3")
		expect(new URL(exchange.url).searchParams.getAll("f")).toEqual(["a", "b"])
		expect(toCurl(exchange, { redactor: new Redactor() })).toContain("f=a&f=b&g=c")
	})

	it("leaves a parameter out when the array is empty", async () => {
		await new Client({ baseUrl: url, redactor: new Redactor() }).get("/notes", { query: { f: [], g: "c" } })
		expect(seen.at(-1)).toBe("/notes?g=c")
	})

	it("does not add a required default beside a parameter the caller repeats", async () => {
		const client = new Client({
			baseUrl: url,
			operationResolver: () => ({
				operationId: "note.list",
				requiredQuery: { f: "default", tenant: "t1" },
				template: "/notes",
			}),
			redactor: new Redactor(),
		})
		await client.get("/notes", { query: { f: ["a", "b"] } })
		expect(seen.at(-1)).toBe("/notes?f=a&f=b&tenant=t1")
	})
})

describe("mergeQuery", () => {
	it("appends a repeated key's values when the grammar repeats parameters", () => {
		expect(mergeQuery({ f: "a", g: "x" }, { f: "b" }, true)).toEqual({ f: ["a", "b"], g: "x" })
		expect(mergeQuery({ f: ["a", "b"] }, { f: ["c"] }, true)).toEqual({ f: ["a", "b", "c"] })
	})

	it("lets the later value win otherwise, as an object spread does", () => {
		expect(mergeQuery({ f: "a", g: "x" }, { f: "b" }, false)).toEqual({ f: "b", g: "x" })
	})

	it("keeps distinct keys from both sides either way", () => {
		expect(mergeQuery({ a: "1" }, { b: "2" }, true)).toEqual({ a: "1", b: "2" })
	})
})
