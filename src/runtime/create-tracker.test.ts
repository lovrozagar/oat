import { describe, expect, it } from "vitest"
import type { Client } from "../client/client.ts"
import type { Exchange } from "./exchange.ts"
import { createTracker } from "./create-tracker.ts"
import { Ledger } from "./teardown/ledger.ts"
import type { Owner } from "./teardown/types.ts"
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
const LINE = { properties: { message: { type: "string" } }, type: "object" }
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
		"/columns/{column_id}": {
			get: {
				operationId: "column.read",
				parameters: [{ in: "path", name: "column_id", required: true, schema: { type: "string" } }],
				responses: { "200": { ...json(ITEM), description: "ok" } },
				...entity("read", "column"),
			},
		},
		"/logs": {
			get: {
				operationId: "log.list",
				responses: { "200": { ...json({ items: LINE, type: "array" }), description: "ok" } },
				...entity("list", "log"),
			},
		},
		"/settings": {
			get: {
				operationId: "settings.read",
				responses: { "200": { ...json(ITEM), description: "ok" } },
				...entity("read", "settings"),
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

const owner = (id: string): Owner => ({ id })

/* A ledger that keeps what it was told was read back, which the real one keeps private. */
class WatchedLedger extends Ledger {
	readonly readBack: string[] = []
	override sighted(name: string, id: string, principal: string): void {
		this.readBack.push(`${name} ${id} ${principal}`)
		super.sighted(name, id, principal)
	}
}

function setup() {
	const model = buildModel(dereference(DOCUMENT).doc)
	const ledger = new WatchedLedger()
	const recorded: string[] = []
	/* No read is needed: every answer here names its own id. */
	const client = {
		get: () => Promise.reject(new Error("no read expected")),
		relativePath: (url: string) => new URL(url).pathname,
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
})

describe("createTracker, on what it does not ledger", () => {
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

const read = (over: Partial<Exchange>): Exchange => exchange({ method: "GET", status: 200, ...over })

describe("createTracker, on what a principal reads back", () => {
	it("sights a record under the read's id, or each identified row of a listing", async () => {
		const { ledger, tracker } = setup()
		await tracker.observe(
			read({ operationId: "column.read", pathParams: { column_id: "c1" }, template: "/columns/{column_id}" }),
		)
		await tracker.observe(read({ operationId: "table.list", responseBody: [{ id: "r1" }, { name: "no id" }] }))
		await tracker.observe(read({ operationId: "log.list", responseBody: [{ id: "l1", message: "m" }] }))
		expect(ledger.readBack).toEqual(["column c1 beta", "table r1 beta", "log l1 beta"])
	})

	it("sights nothing a read names no id for, and nothing that is not a read or a listing", async () => {
		const { ledger, tracker } = setup()
		await tracker.observe(read({ operationId: "column.read", template: "/elsewhere", url: "http://x/elsewhere" }))
		await tracker.observe(read({ operationId: "settings.read", template: "/settings", url: "http://x/settings" }))
		const unnamed: Partial<Exchange> = read({})
		delete unnamed.operationId
		await tracker.observe(unnamed as Exchange)
		await tracker.observe(read({ operationId: "table.delete" }))
		expect(ledger.readBack).toEqual([])
	})
})

describe("createTracker, on a create it cannot place", () => {
	it("passes over a write that names no operation", async () => {
		const { ledger, tracker } = setup()
		const unnamed: Partial<Exchange> = exchange({})
		delete unnamed.operationId
		await tracker.observe(unnamed as Exchange)
		expect(ledger.entries()).toEqual([])
		expect(ledger.unidentifiedCreates).toEqual([])
	})

	it("reports a create whose path does not fit the create's own template", async () => {
		const { ledger, tracker } = setup()
		const astray = exchange({ template: "/elsewhere", url: "http://x/elsewhere" })
		await tracker.observe(astray)
		expect(ledger.entries()).toEqual([])
		expect(ledger.unidentifiedCreates).toMatchObject([{ entity: "table", seq: astray.seq }])
	})
})
