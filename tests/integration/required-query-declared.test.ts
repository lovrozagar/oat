import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { Client } from "../../src/client/client.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { operationResolver } from "../../src/spec/graph/resolver.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Redactor } from "../../src/security/redact.ts"

/*
 * A list the document says needs ?locale= is refused without it. Every read oat makes of that list
 * carries the value the document declares for it, so a check grades the listing and not the
 * refusal of a request the document already called incomplete. oat never invents a value the
 * document does not give.
 */

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()))
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

const spec: OpenApiDocument = {
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

async function client(): Promise<{ client: Client; seen: string[] }> {
	const seen: string[] = []
	const server = createServer((req, res) => {
		seen.push(req.url ?? "")
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ articles: [] }))
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	const made = new Client({
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		operationResolver: operationResolver(buildModel(dereference(spec).doc)),
		redactor: new Redactor(),
	})
	return { client: made, seen }
}

describe("required query parameters", () => {
	it("are sent with the value the document declares when the caller names none", async () => {
		const { client: c, seen } = await client()
		await c.get("/v1/articles", { as: { anonymous: true }, query: { limit: 5 } })
		expect(seen).toEqual(["/v1/articles?limit=5&locale=en&format=json"])
	})

	it("yield to a value the caller sets, or omits on purpose", async () => {
		const { client: c, seen } = await client()
		await c.get("/v1/articles", { as: { anonymous: true }, query: { format: "csv", locale: "pt-BR" } })
		await c.get("/v1/articles", { as: { anonymous: true }, query: { format: undefined, locale: undefined } })
		expect(seen).toEqual(["/v1/articles?format=csv&locale=pt-BR", "/v1/articles"])
	})

	it("are not invented when the document declares no value", async () => {
		const { client: c, seen } = await client()
		await c.get("/v1/authors", { as: { anonymous: true } })
		expect(seen).toEqual(["/v1/authors"])
	})
})
