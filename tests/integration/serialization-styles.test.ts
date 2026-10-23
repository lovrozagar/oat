import { afterEach, describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Listeners, reply, serve } from "../support/effects-fixtures.ts"
import { JWT_LOGIN } from "../support/reference-auth.ts"
import { wireLog } from "../support/wire-log.ts"

/*
 * Each parameter goes on the wire in the style and explode its document declares (OAS 3.1
 * §4.8.12.4). The reference's styles route answers 200 only for a deepObject range and pipe-delimited
 * ids; the reference has no route for the other styles, so a small document over a recording server
 * shows the rest exactly as the server read them.
 */

const listeners = new Listeners()
afterEach(() => listeners.closeAll())

describe("the reference's styles route", () => {
	it("passes styles.read with the range as deepObject and the ids pipe-delimited", async () => {
		const server = await createMemoryServer()
		try {
			const log = wireLog()
			const result = await run({
				baseUrl: server.url,
				network: { fetch: log.fetch },
				ops: ["styles.read"],
				principals: { alpha: { key: "key_alpha" } },
				security: JWT_LOGIN,
				seed: 1,
				spec: `${server.url}/v1/openapi/spec`,
			})
			expect(result.scope.operations.find((op) => op.operationId === "styles.read")?.status).toBe("passed")
			const sent = log.entries.filter((entry) => entry.path.startsWith("/v1/styles?") && entry.status === 200)
			expect(sent.map((entry) => entry.path)).toContain("/v1/styles?range[max]=5&range[min]=1&ids=a|b")
			expect(JSON.parse(sent[0]?.answer ?? "{}")).toEqual({ ids: ["a", "b"], range: { max: 5, min: 1 } })
		} finally {
			await server.close()
		}
	})
})

/* A required parameter with a declared example, in `where`; the schema follows the example's shape. */
function param(where: string, name: string, example: unknown) {
	const schema = Array.isArray(example)
		? { items: { type: "string" }, type: "array" }
		: typeof example === "object"
			? {
					properties: Object.fromEntries(Object.keys(example as object).map((key) => [key, { type: "string" }])),
					type: "object",
				}
			: { type: "string" }
	return { example, in: where, name, required: true, schema }
}

/* A path parameter whose one enum value is what the run sends. */
const pathParam = (name: string, style: string) => ({
	in: "path",
	name,
	required: true,
	schema: { enum: ["red"], type: "string" },
	style,
})

const STYLED = [
	pathParam("simple", "simple"),
	pathParam("label", "label"),
	pathParam("matrix", "matrix"),
	param("query", "tags", ["a", "b"]),
	{ ...param("query", "colors", ["red", "green"]), explode: false },
	{ ...param("query", "words", ["x", "y"]), explode: false, style: "spaceDelimited" },
	{ ...param("query", "pipes", ["p", "q"]), explode: false, style: "pipeDelimited" },
	param("query", "point", { lat: "1", lng: "2" }),
	{ ...param("query", "box", { h: "4", w: "3" }), explode: false },
	{ ...param("query", "range", { max: "5", min: "1" }), style: "deepObject" },
	{ ...param("query", "next", "a/b?c"), allowReserved: true },
	param("header", "X-Ids", ["a", "b"]),
	{ ...param("header", "X-Pair", { k: "v", k2: "v2" }), explode: true },
	{ ...param("cookie", "prefs", ["a", "b"]), explode: false },
	param("cookie", "theme", "dark"),
]

const SPEC = {
	info: { title: "styles", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/styled/{simple}/{label}/{matrix}": {
			get: {
				operationId: "styled.read",
				parameters: STYLED,
				responses: { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
			},
		},
	},
} as unknown as OpenApiDocument

/** What the server read: the raw request target, and the styled headers and cookie. */
interface Read {
	target: string
	ids: string | undefined
	pair: string | undefined
	cookie: string | undefined
}

describe("every parameter style a run writes", () => {
	it("sends path, query, header and cookie values exactly as their declared styles write them", async () => {
		const reads: Read[] = []
		const server = await serve(listeners, SPEC, [
			({ req, res }) => {
				const { cookie, "x-ids": ids, "x-pair": pair } = req.headers as Record<string, string | undefined>
				reads.push({ cookie, ids, pair, target: req.url ?? "" })
				return reply(res, 200, {})
			},
		])
		const result = await run({
			baseUrl: server.url,
			principals: { a: {} },
			seed: 1,
			spec: `${server.url}/v1/openapi/spec`,
		})
		expect(result.scope.operations.map((op) => [op.operationId, op.status])).toEqual([["styled.read", "passed"]])
		expect(reads[0]).toEqual({
			cookie: "prefs=a,b; theme=dark",
			ids: "a,b",
			pair: "k=v,k2=v2",
			target:
				"/v1/styled/red/.red/;matrix=red" +
				"?tags=a&tags=b&colors=red,green&words=x%20y&pipes=p|q&lat=1&lng=2&box=h,4,w,3" +
				"&range[max]=5&range[min]=1&next=a/b?c",
		})
	})
})
