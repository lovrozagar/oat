import { describe, expect, it } from "vitest"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import { createTracker } from "./create-tracker.ts"
import { Ledger, type Owner } from "./teardown.ts"
import { buildModel } from "../spec/graph/build.ts"
import { dereference } from "../spec/load/dereference.ts"
import type { OpenApiDocument } from "../spec/types.ts"

/*
 * The tracker reads one answer at a time. A create's record lives where its own path put it: a
 * value the path names wins over the principal's root of the same name, so a create sent under
 * another root is removed under that root, not under its creator's home.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ITEM = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
const PROJECT = { in: "path", name: "project_id", required: true, schema: { type: "string" } }
const TABLE = { in: "path", name: "table_id", required: true, schema: { type: "string" } }
const entity = (action: string, name = "table") => ({ "x-entity": { action, name } })

const DOCUMENT = {
	info: { title: "tracker", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/me": {
			put: {
				operationId: "me.create",
				requestBody: { ...json(ITEM), required: true },
				responses: { "200": { ...json(ITEM), description: "ok" } },
				"x-entity": { action: "create", identity: "self", name: "me" },
			},
		},
		"/projects/{project_id}/tables": {
			get: {
				operationId: "table.list",
				parameters: [PROJECT],
				responses: { "200": { ...json({ items: ITEM, type: "array" }), description: "ok" } },
				...entity("list"),
			},
			post: {
				operationId: "table.create",
				parameters: [PROJECT],
				requestBody: { ...json(ITEM), required: true },
				responses: { "201": { ...json(ITEM), description: "created" } },
				...entity("create"),
			},
		},
		"/projects/{project_id}/tables/{table_id}": {
			delete: {
				operationId: "table.delete",
				parameters: [PROJECT, TABLE],
				responses: { "204": { description: "gone" } },
				...entity("delete"),
			},
		},
	},
} as unknown as OpenApiDocument

const owner = (id: string): Owner => ({ headers: () => ({ authorization: `Bearer ${id}` }), id })

function setup() {
	const model = buildModel(dereference(DOCUMENT).doc)
	const ledger = new Ledger()
	const recorded: string[] = []
	/* No read is needed: every answer here names its own id. */
	const client = {
		get: () => Promise.reject(new Error("no read expected")),
		view: () => client,
	} as unknown as Client
	const tracker = createTracker({
		client,
		ledger,
		model,
		onRecorded: (name, id) => recorded.push(`${name} ${id}`),
		owners: new Map([
			["alpha", { owner: owner("alpha"), roots: { project_id: "a", region: "eu" } }],
			["beta", { owner: owner("beta"), roots: { project_id: "b" } }],
		]),
		readable: () => true,
	})
	return { ledger, recorded, tracker }
}

let seq = 0
function exchange(over: Partial<Exchange>): Exchange {
	seq += 1
	return {
		at: 0,
		durationMs: 0,
		method: "POST",
		operationId: "table.create",
		pathParams: { project_id: "b" },
		principal: "beta",
		purpose: "probe",
		requestBody: { name: "t" },
		requestBytes: 0,
		requestHeaders: {},
		requestId: "",
		responseBody: { id: "t1", name: "t" },
		responseBytes: 0,
		responseHeaders: {},
		seq,
		status: 201,
		template: "/projects/{project_id}/tables",
		url: "http://x/projects/b/tables",
		...over,
	}
}

describe("createTracker", () => {
	it("ledgers an accepted create under the principal whose credential it carried", async () => {
		const { ledger, recorded, tracker } = setup()
		await tracker.observe(exchange({}))
		expect(ledger.entries()).toMatchObject([{ entity: "table", id: "t1", owner: { id: "beta" } }])
		expect(recorded).toEqual(["table t1"])
	})

	it("takes a path value over the principal's root of the same name, and keeps the other roots", async () => {
		const { ledger, tracker } = setup()
		await tracker.observe(
			exchange({ pathParams: { project_id: "b" }, principal: "alpha", url: "http://x/projects/b/tables" }),
		)
		expect(ledger.entries()[0]?.scope).toEqual({ project_id: "b", region: "eu" })
		expect(ledger.entries()[0]?.owner.id).toBe("alpha")
	})

	it("leaves alone what no configured principal sent, what was refused, and what is not a create", async () => {
		const { ledger, tracker } = setup()
		const anonymous: Partial<Exchange> = exchange({})
		delete anonymous.principal
		await tracker.observe(anonymous as Exchange)
		await tracker.observe(exchange({ principal: "stranger" }))
		await tracker.observe(exchange({ status: 403 }))
		await tracker.observe(exchange({ method: "GET", operationId: "table.list", status: 200 }))
		expect(ledger.entries()).toEqual([])
		expect(ledger.unidentifiedCreates).toEqual([])
	})

	it("leaves teardown's and seeding's own traffic to them", async () => {
		const { ledger, tracker } = setup()
		await tracker.observe(exchange({ purpose: "teardown" }))
		await tracker.observe(exchange({ purpose: "seed" }))
		expect(ledger.entries()).toEqual([])
	})

	it("leaves an account the caller is to teardownPrincipal", async () => {
		const { ledger, tracker } = setup()
		await tracker.observe(
			exchange({
				method: "PUT",
				operationId: "me.create",
				pathParams: {},
				status: 200,
				template: "/me",
				url: "http://x/me",
			}),
		)
		expect(ledger.entries()).toEqual([])
		expect(ledger.unidentifiedCreates).toEqual([])
	})

	it("reports a create whose answer names an empty id: nothing can be removed by it", async () => {
		const { ledger, tracker } = setup()
		const blank = exchange({ responseBody: { id: "", name: "t" } })
		await tracker.observe(blank)
		expect(ledger.entries()).toEqual([])
		expect(ledger.unidentifiedCreates).toMatchObject([{ entity: "table", seq: blank.seq }])
	})

	it("reports a create whose answer names no id it can read", async () => {
		const { ledger, tracker } = setup()
		const unread = exchange({ responseBody: { ok: true } })
		await tracker.observe(unread)
		expect(ledger.entries()).toEqual([])
		expect(ledger.unidentifiedCreates).toMatchObject([{ entity: "table", seq: unread.seq }])
	})
})
