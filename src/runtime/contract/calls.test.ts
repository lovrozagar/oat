import { describe, expect, it } from "vitest"
import { exchangeOf } from "../checks/__fixtures__/harness.ts"
import { runContractCalls } from "./calls.ts"
import { doc, json, ok, pathParam, stage } from "./__fixtures__/stage.ts"

const item = { properties: { id: { type: "string" } }, type: "object" }

/* Things: a list, a create, a read under an id, a destructive purge, and a query-bound search. */
const things = doc({
	"/things": {
		get: { operationId: "things.list", responses: ok({ items: item, type: "array" }) },
		post: {
			operationId: "things.create",
			requestBody: json({ properties: { name: { type: "string" } }, required: ["name"], type: "object" }),
			responses: { "201": { description: "made", ...json(item) } },
		},
	},
	"/things/{thing_id}": {
		get: { operationId: "things.get", parameters: [pathParam("thing_id")], responses: ok(item) },
	},
	"/purge": { post: { operationId: "things.purge", responses: ok(), "x-destructive": true } },
	"/search": {
		get: {
			operationId: "things.search",
			parameters: [{ in: "query", name: "q", required: true, schema: { type: "string" } }],
			responses: ok(),
			"x-bind": { query: { q: "needle" } },
		},
	},
	"/upload": {
		post: {
			operationId: "things.upload",
			requestBody: { content: { "text/csv": { schema: { type: "string" } } } },
			responses: ok(),
		},
	},
	"/blob": {
		get: {
			operationId: "things.blob",
			parameters: [{ in: "query", name: "b", required: true, schema: { type: "object" } }],
			responses: ok(),
		},
	},
})

describe("runContractCalls", () => {
	it("calls every operation nothing graded, once, with what it can build", async () => {
		const { input, sent } = stage(things, (method, path) =>
			method === "POST" && path === "/things" ? { body: { id: "t1" }, status: 201 } : { body: [], status: 200 },
		)
		await runContractCalls(input)
		expect(input.checksRun.has("response.contract-call")).toBe(true)
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /things",
			"POST /things",
			"GET /search",
		])
		expect(sent[2]?.options.query).toEqual({ q: "needle" })
		expect(sent[0]?.options).not.toHaveProperty("query")
		expect(sent[0]?.options).not.toHaveProperty("body")
		expect([...(input.grades.needs.get("things.get") ?? [])]).toEqual(["unresolved param thing_id"])
		expect([...(input.grades.needs.get("things.upload") ?? [])]).toEqual([
			"needs a text/csv body oat cannot build without a scenario",
		])
		expect([...(input.grades.needs.get("things.blob") ?? [])]).toEqual(["unresolved query param b"])
		expect(input.grades.ran.has("things.purge")).toBe(false)
	})

	it("judges an earlier success instead of calling again", async () => {
		const { input, sent } = stage(things, () => ({ status: 200 }), {
			mode: "targeted",
			inScope: (id) => id === "things.list",
		})
		input.client.transcript.push(
			exchangeOf(
				{ method: "GET", options: { operationId: "things.list" }, path: "/things" },
				{ body: [], status: 200 },
			),
		)
		await runContractCalls(input)
		expect(sent).toEqual([])
		expect(input.grades.evidence.has("things.list")).toBe(true)
	})
})

describe("runContractCalls on what it leaves alone", () => {
	it("leaves out what a scenario owns, a check graded, or evidence proved", async () => {
		const { input, sent } = stage(things, () => ({ status: 200 }), {
			owned: new Set(["things.list"]),
		})
		input.grades.graded(["things.create"], "some.check")
		input.grades.prove("things.search", { call: 1 })
		input.grades.suppress(["things.get"], "x")
		await runContractCalls(input)
		expect(sent.map((request) => request.path)).toEqual([])
	})

	it("sends nothing when everything is graded, or once the run stopped", async () => {
		const none = stage(things, () => ({ status: 200 }), { inScope: () => false, mode: "targeted" })
		await runContractCalls(none.input)
		expect(none.input.checksRun.size).toBe(0)
		const stopped = stage(things, () => ({ status: 200 }), { stopped: () => true })
		await runContractCalls(stopped.input)
		expect(stopped.sent).toEqual([])
		expect(stopped.input.checksRun.has("response.contract-call")).toBe(true)
	})

	it("skips an operation whose call could not be sent", async () => {
		const { input } = stage(things, () => {
			throw new Error("fenced")
		})
		await runContractCalls(input)
		expect([...(input.grades.needs.get("things.list") ?? [])]).toEqual(["contract call could not be sent: fenced"])
		const odd = stage(things, () => {
			throw "dropped"
		})
		await runContractCalls(odd.input)
		expect([...(odd.input.grades.needs.get("things.list") ?? [])]).toEqual(["contract call could not be sent: dropped"])
	})
})
