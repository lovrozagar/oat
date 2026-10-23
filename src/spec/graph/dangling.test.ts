import { describe, expect, it } from "vitest"
import { ok } from "../__fixtures__/documents.ts"
import { modelOf } from "./__fixtures__/operations.ts"
import type { SpecModel } from "./types.ts"

/* A $ref that points at nothing: an unconstrained schema with a gap, or anywhere else an untested operation. */

const MISSING = "#/components/schemas/AppFeeAllocation"
const fee = { $ref: MISSING }
const order = { properties: { fee, fees: { items: fee, type: "array" } }, type: "object" }
const orderRef = { $ref: "#/components/schemas/Order" }
const body = (schema: unknown) => ({ content: { "application/json": { schema } } })
const item = { properties: { id: { type: "string" } }, type: "object" }

const refGaps = (model: SpecModel) =>
	model.gaps.gaps.filter((gap) => gap.tag === "$ref").map((gap) => `${gap.operationId}: ${gap.detail}`)

const gone = (name: string) => ({ $ref: `#/components/x/${name}` })
const media = (extra: Record<string, unknown>) => ({ content: { "application/json": { schema: item, ...extra } } })

const untested = (ptr: string) => `$ref ${ptr} points at nothing; oat leaves this operation untested`

describe("a dangling $ref in a schema", () => {
	it("reads as unconstrained, with a gap on each operation whose request or response reaches it", () => {
		const model = modelOf(
			{
				"/orders": {
					get: { operationId: "orders.list", responses: ok({ items: orderRef, type: "array" }) },
					post: { operationId: "orders.create", requestBody: body(orderRef), responses: ok(item) },
				},
				"/health": {
					get: { operationId: "health.get", responses: ok(item, { links: { self: { operationId: "health.get" } } }) },
				},
			},
			{ components: { schemas: { Order: order } } },
		)
		const detail = `$ref ${MISSING} points at nothing; oat reads that schema as unconstrained`
		expect(refGaps(model)).toEqual([`orders.list: ${detail}`, `orders.create: ${detail}`])
		expect(model.operations.map((op) => op.unsendable)).toEqual([null, null, null])
	})

	it("is found wherever a schema sits: parameters, headers, item schemas, and recursive definitions", () => {
		const node = { properties: { child: { $ref: "#/components/schemas/Node" }, fee }, type: "object" }
		const header = { content: { "text/plain": { schema: fee } } }
		const model = modelOf(
			{
				"/a": { get: { operationId: "a", parameters: [{ in: "query", name: "q", schema: fee }], responses: {} } },
				"/b": { get: { operationId: "b", responses: { "200": { description: "ok", headers: { X: header } } } } },
				"/c": {
					get: { operationId: "c", responses: { "200": { content: { "text/event-stream": { itemSchema: fee } } } } },
				},
				"/d": { get: { operationId: "d", responses: ok({ $ref: "#/components/schemas/Node" }) } },
				"/e": { get: { operationId: "e", responses: ok({ example: { $ref: MISSING }, type: "object" }) } },
			},
			{ components: { schemas: { Node: node } } },
		)
		expect(refGaps(model).map((line) => line.split(":")[0])).toEqual(["a", "b", "c", "d"])
		expect(model.operations.every((op) => op.unsendable === null)).toBe(true)
	})
})

describe("a dangling $ref anywhere else", () => {
	it("leaves the operation untested with the reason, and models and runs the rest", () => {
		const missing = "#/components/parameters/Missing"
		const model = modelOf({
			"/things": {
				get: {
					operationId: "things.list",
					parameters: [{ $ref: missing }],
					responses: ok({ items: item, type: "array" }),
				},
				post: { operationId: "things.create", requestBody: body(item), responses: ok(item) },
			},
			"/things/{id}": {
				get: {
					operationId: "things.get",
					parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
					responses: ok(item),
				},
			},
		})
		const list = model.byOperationId.get("things.list")
		expect(list).toMatchObject({ action: null, entity: null, unsendable: `$ref ${missing} points at nothing` })
		expect(refGaps(model)).toEqual([`things.list: ${untested(missing)}`])
		const create = model.byOperationId.get("things.create")
		expect(create).toMatchObject({ entity: "thing", unsendable: null })
		expect(model.entities.get("thing")).toMatchObject({ create: "things.create", read: "things.get" })
		expect(model.entities.get("thing")?.list).toBeUndefined()
	})
})

describe("a dangling $ref outside a schema", () => {
	it("is found in a body, a response, a media type, a header, an encoding, an example and a link", () => {
		const model = modelOf({
			"/body": { post: { operationId: "body", requestBody: gone("body"), responses: {} } },
			"/response": { get: { operationId: "response", responses: { "200": gone("response") } } },
			"/media": {
				get: { operationId: "media", responses: { "200": { content: { "application/json": gone("media") } } } },
			},
			"/header": { get: { operationId: "header", responses: { "200": { headers: { X: gone("header") } } } } },
			"/encoding": {
				post: {
					operationId: "encoding",
					requestBody: media({ encoding: { file: { headers: { X: gone("encoding") } } } }),
					responses: {},
				},
			},
			"/example": {
				get: {
					operationId: "example",
					parameters: [{ examples: { a: gone("example") }, in: "query", name: "q" }],
					responses: {},
				},
			},
			"/link": { get: { operationId: "link", responses: { "200": { links: { next: gone("link") } } } } },
		})
		const reasons = model.operations.map((op) => op.unsendable)
		expect(reasons).toEqual([
			"$ref #/components/x/body points at nothing",
			"$ref #/components/x/response points at nothing",
			"$ref #/components/x/media points at nothing",
			"$ref #/components/x/header points at nothing",
			"$ref #/components/x/encoding points at nothing",
			"$ref #/components/x/example points at nothing",
			"$ref #/components/x/link points at nothing",
		])
	})
})

describe("a dangling $ref in a callback", () => {
	it("is found in a callback, its path items and their operations, schemas there still read as unconstrained", () => {
		const model = modelOf({
			"/callback": {
				post: {
					callbacks: {
						onEvent: gone("callback"),
						onDone: { "{$url}": gone("pathItem") },
						onSent: { "{$url}": { post: { requestBody: gone("callbackBody"), responses: {} } } },
						onSchema: { "{$url}": { parameters: [{ in: "query", name: "q", schema: fee }] } },
					},
					operationId: "callback",
					responses: {},
				},
			},
		})
		expect(model.byOperationId.get("callback")?.unsendable).toBe("$ref #/components/x/callback points at nothing")
		expect(refGaps(model)).toEqual([
			`callback: $ref ${MISSING} points at nothing; oat reads that schema as unconstrained`,
			`callback: ${untested("#/components/x/callback")}`,
			`callback: ${untested("#/components/x/pathItem")}`,
			`callback: ${untested("#/components/x/callbackBody")}`,
		])
	})
})

describe("a dangling $ref in a path item", () => {
	it("from a path item's shared parameters leaves each operation under it untested, and keeps a method's own reason", () => {
		const missing = "#/components/parameters/Org"
		const model = modelOf({
			"/orgs/{org}": {
				get: { operationId: "orgs.get", responses: ok(item) },
				parameters: [{ $ref: missing }],
				trace: { operationId: "orgs.trace", responses: {} },
			},
		})
		expect(model.byOperationId.get("orgs.get")?.unsendable).toBe(`$ref ${missing} points at nothing`)
		expect(model.byOperationId.get("orgs.trace")?.unsendable).toMatch(/^fetch refuses TRACE/)
		expect(refGaps(model)).toEqual([`orgs.get: ${untested(missing)}`, `orgs.trace: ${untested(missing)}`])
	})
})
