import { describe, expect, it } from "vitest"
import { MissingValueError } from "../errors/missing-value.ts"
import { Redactor } from "../security/redact.ts"
import { buildModel } from "../spec/graph/build.ts"
import { operationResolver } from "../spec/graph/resolver.ts"
import { dereference } from "../spec/load/dereference.ts"
import type { OpenApiDocument } from "../spec/types.ts"
import { json, transport } from "./__fixtures__/transport.ts"
import { Client } from "./client.ts"
import type { Actor } from "./credential-source.ts"
import { toCurl } from "./curl.ts"
import type { ClientOptions } from "./types.ts"

/* What a request's query string carries, as the backend receives it. */

const ANON: Actor = { anonymous: true }

/* A client over a transport that answers `body`, and the path and query of each request it sent. */
function clientOf(more: Partial<ClientOptions> = {}, body: unknown = []): { client: Client; seen: () => string[] } {
	const wire = transport(() => json(body))
	const client = new Client({
		baseUrl: "http://api.test",
		network: { fetchImpl: wire.fetch },
		redactor: new Redactor(),
		...more,
	})
	const seen = () => wire.sent.map((request) => new URL(request.url).pathname + new URL(request.url).search)
	return { client, seen }
}

/*
 * Some grammars write one filter term per parameter and repeat the parameter for each term:
 * `?filter=and_Qty_eq_2&filter=and_Name_eq_x`. The client must send every occurrence, in order,
 * and everything that shows the request afterwards must show it as sent.
 */
describe("repeated query parameters", () => {
	it("sends every value of an array, in order, next to scalar parameters", async () => {
		const { client, seen } = clientOf()
		const exchange = await client.get("/notes", { as: ANON, query: { f: ["a", "b"], g: "c", n: 3 } })
		expect(seen()).toEqual(["/notes?f=a&f=b&g=c&n=3"])
		expect(new URL(exchange.url).searchParams.getAll("f")).toEqual(["a", "b"])
		expect(toCurl(exchange, { redactor: new Redactor() })).toContain("f=a&f=b&g=c")
	})

	it("leaves a parameter out when the array is empty", async () => {
		const { client, seen } = clientOf()
		await client.get("/notes", { as: ANON, query: { f: [], g: "c" } })
		expect(seen()).toEqual(["/notes?g=c"])
	})

	it("does not add a required default beside a parameter the caller repeats", async () => {
		const { client, seen } = clientOf({
			operationResolver: () => ({
				operationId: "note.list",
				requiredQuery: { f: "default", tenant: "t1" },
				template: "/notes",
			}),
		})
		await client.get("/notes", { as: ANON, query: { f: ["a", "b"] } })
		expect(seen()).toEqual(["/notes?f=a&f=b&tenant=t1"])
	})
})

const listing = {
	"200": {
		content: {
			"application/json": {
				schema: {
					properties: { articles: { items: { type: "object" }, type: "array" } },
					required: ["articles"],
					type: "object",
				},
			},
		},
		description: "ok",
	},
}

const spec = {
	info: { title: "required-query", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/v1/articles": {
			get: {
				operationId: "article.list",
				parameters: [
					{ in: "query", name: "limit", schema: { type: "integer" } },
					{
						in: "query",
						name: "locale",
						required: true,
						schema: { examples: ["en"], pattern: "^[a-z]{2,3}(-[A-Z]{2})?$", type: "string" },
					},
					{ in: "query", name: "format", required: true, schema: { enum: ["json", "csv"], type: "string" } },
				],
				responses: listing,
			},
		},
		"/v1/authors": {
			get: {
				operationId: "author.list",
				parameters: [{ in: "query", name: "locale", required: true, schema: { type: "string" } }],
				responses: listing,
			},
		},
	},
} as OpenApiDocument

const declaring = (): ReturnType<typeof clientOf> =>
	clientOf({ operationResolver: operationResolver(buildModel(dereference(spec).doc)) }, { articles: [] })

/*
 * A list the document says needs ?locale= is refused without it. Every read oat makes of that list
 * carries the value the document declares for it, so a check grades the listing and not the
 * refusal of a request the document already called incomplete. oat never invents a value the
 * document does not give.
 */
describe("required query parameters", () => {
	it("are sent with the value the document declares when the caller names none", async () => {
		const { client, seen } = declaring()
		await client.get("/v1/articles", { as: ANON, query: { limit: 5 } })
		expect(seen()).toEqual(["/v1/articles?limit=5&locale=en&format=json"])
	})

	it("yield to a value the caller sets, or omits on purpose", async () => {
		const { client, seen } = declaring()
		await client.get("/v1/articles", { as: ANON, query: { format: "csv", locale: "pt-BR" } })
		await client.get("/v1/articles", { as: ANON, query: { format: undefined, locale: undefined } })
		expect(seen()).toEqual(["/v1/articles?format=csv&locale=pt-BR", "/v1/articles"])
	})

	it("are not invented when the document declares no value", async () => {
		const { client, seen } = declaring()
		await client.get("/v1/authors", { as: ANON })
		expect(seen()).toEqual(["/v1/authors"])
	})
})

/*
 * A record without its identity used to become the text "undefined" in a path (`GET /notes/undefined`),
 * a filter (`ID eq undefined`) or a tenant probe. A request built from a missing value says nothing
 * about the backend: the check that wanted it does not apply, and nothing is sent.
 */
describe("a missing value", () => {
	it("sends nothing whose path or query carries one", async () => {
		const { client, seen } = clientOf({}, {})
		await expect(client.request("GET", "/v1/notes/undefined", { as: ANON })).rejects.toBeInstanceOf(MissingValueError)
		await expect(
			client.request("GET", "/v1/notes", { as: ANON, query: { filter: "undefined" } }),
		).rejects.toBeInstanceOf(MissingValueError)
		await expect(client.request("GET", "/v1/notes?ID=undefined", { as: ANON })).rejects.toBeInstanceOf(
			MissingValueError,
		)
		/* A parameter named undefined on purpose is left out, and the text `null` is a value. */
		await client.request("GET", "/v1/notes", { as: ANON, query: { filter: undefined, x: "null" } })
		expect(seen()).toEqual(["/v1/notes?x=null"])
	})
})
