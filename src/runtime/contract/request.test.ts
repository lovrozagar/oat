import { describe, expect, it } from "vitest"
import type { OperationObject } from "../../spec/types.ts"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { readActionBind } from "../effects/bind.ts"
import { doc, json, ok, pathParam, stage } from "./__fixtures__/stage.ts"
import { parametersOf } from "./params.ts"
import { bodyOf, pathValues, queryValues } from "./request.ts"

/** The stage over `paths`, and its operation `operationId` with its raw form and parameters. */
function staged(paths: Record<string, unknown>, operationId: string, fields: Parameters<typeof stage>[2] = {}) {
	const { input, model } = stage(doc(paths), () => undefined, fields)
	const op = model.byOperationId.get(operationId)
	if (op === undefined) throw new Error(`no ${operationId}`)
	const raw = model.rawOperations.get(operationId) as OperationObject
	return { input, op, params: parametersOf(raw), raw }
}

describe("pathValues", () => {
	const paths = {
		"/a/{org_id}/{kind}/{thing_id}/{seen_id}": {
			get: {
				operationId: "deep.get",
				parameters: [
					pathParam("org_id"),
					pathParam("kind", { enum: ["red", "blue"] }),
					pathParam("thing_id", { enum: [] }),
					pathParam("seen_id"),
				],
				responses: ok(),
			},
		},
	}

	it("takes roots, then a declared enum, then the hook, then an earlier success", async () => {
		const asked: unknown[] = []
		const { input, op, params } = staged(paths, "deep.get", {
			hooks: {
				resolvePathValue: async (request) => {
					asked.push(request)
					return request.param === "thing_id" ? "t-hook" : null
				},
			},
			roots: { org_id: "o1" },
		})
		input.client.transcript.push(exchange("GET", "/x", { body: { seen_id: "s1" }, status: 200 }))
		expect(await pathValues(input, { op, params }, { h: "1" })).toEqual({
			kind: "red",
			org_id: "o1",
			seen_id: "s1",
			thing_id: "t-hook",
		})
		expect(asked).toEqual([
			{ enumValues: [], headers: { h: "1" }, method: "GET", operationId: "deep.get", param: "thing_id", path: op.path },
			{ enumValues: [], headers: { h: "1" }, method: "GET", operationId: "deep.get", param: "seen_id", path: op.path },
		])
	})

	it("skips the operation at the first value nothing resolves", async () => {
		const { input, op, params } = staged(paths, "deep.get", {
			hooks: { resolvePathValue: async () => null },
		})
		expect(await pathValues(input, { op, params }, {})).toBeNull()
		expect([...(input.grades.needs.get("deep.get") ?? [])]).toEqual(["unresolved param org_id"])
	})

	it("works without a hook or a declared parameter", async () => {
		const { input, op } = staged(paths, "deep.get", { roots: { org_id: "o1" } })
		expect(await pathValues(input, { op, params: [] }, {})).toBeNull()
		expect([...(input.grades.needs.get("deep.get") ?? [])]).toEqual(["unresolved param kind"])
	})
})

const query = (name: string, schema: unknown, required = true) => ({ in: "query", name, required, schema })
const queried = (parameters: unknown[]) => ({ "/q": { get: { operationId: "q.get", parameters, responses: ok() } } })

describe("queryValues", () => {
	it("takes x-bind's literal, then the document's required value, then an example", () => {
		const { input, op, params } = staged(
			queried([
				query("bound", { type: "string" }),
				query("typed", { type: "integer" }),
				query("optional", { type: "string" }, false),
				{ in: "header", name: "x", required: true },
			]),
			"q.get",
		)
		const bind = readActionBind({ query: { bound: "lit", other: "$.ptr" } })
		expect(queryValues(input.grades, { bind, op, params })).toEqual({ bound: "lit", typed: "1" })
		expect(queryValues(input.grades, { bind: null, op: { ...op, requiredQuery: { typed: "9" } }, params })).toEqual({
			bound: "oat",
			typed: "9",
		})
	})

	it("skips the operation at a required value nothing names", () => {
		const { input, op, params } = staged(queried([query("blob", { type: "object" })]), "q.get")
		expect(queryValues(input.grades, { bind: null, op, params })).toBeNull()
		expect([...(input.grades.needs.get("q.get") ?? [])]).toEqual(["unresolved query param blob"])
	})
})

const post = (requestBody?: unknown) => ({
	"/p": { post: { operationId: "p.post", ...(requestBody === undefined ? {} : { requestBody }), responses: ok() } },
})

describe("bodyOf", () => {
	it("sends no body when none is documented", () => {
		const { input, op, raw } = staged(post(), "p.post")
		expect(bodyOf(input, { bind: null, op, raw })).toEqual({ body: undefined })
	})

	it("skips a body that is not JSON", () => {
		const { input, op, raw } = staged(post({ content: { "text/csv": { schema: { type: "string" } } } }), "p.post")
		expect(bodyOf(input, { bind: null, op, raw })).toBeNull()
		expect([...(input.grades.needs.get("p.post") ?? [])]).toEqual([
			"needs a text/csv body oat cannot build without a scenario",
		])
	})

	it("builds an object from the schema and overlays x-bind", () => {
		const schema = {
			properties: { mode: { type: "string" }, name: { type: "string" } },
			required: ["name", "mode"],
			type: "object",
		}
		const { input, op, raw } = staged(post(json(schema)), "p.post")
		const built = bodyOf(input, { bind: readActionBind({ body: { mode: "fast" } }), op, raw })
		expect(built?.body).toMatchObject({ mode: "fast" })
		expect(typeof (built as { body: { name?: unknown } }).body.name).toBe("string")
	})

	it("sends an empty object for a schema-less body, and throws on a body that is not an object", () => {
		const list = staged(post(json({ items: { type: "integer" }, minItems: 1, type: "array" })), "p.post")
		expect(() => bodyOf(list.input, { bind: null, op: list.op, raw: list.raw })).toThrow(
			/cannot generate a valid body for p.post/,
		)
		const bare = staged(post({ content: { "application/json": {} } }), "p.post")
		expect(bodyOf(bare.input, { bind: null, op: bare.op, raw: bare.raw })).toEqual({ body: {} })
	})
})
