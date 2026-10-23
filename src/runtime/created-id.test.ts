import { describe, expect, it } from "vitest"
import type { OperationModel, SpecModel } from "../spec/graph/types.ts"
import {
	answeredIdOf,
	type CreatedIdSource,
	createdIdOf,
	createdRecordOf,
	locatedId,
	resolveCreatedId,
} from "./created-id.ts"

const NONE: CreatedIdSource = { createdIdFrom: null, recordPath: null }

describe("createdRecordOf", () => {
	it("is the top level unless an envelope holds more of what was sent", () => {
		const sent = { flag: true, name: "a", tags: ["x"] }
		expect(createdRecordOf({ data: { ID: 9, flag: true, name: "a" }, id: 9, success: true }, "ID", sent)).toEqual({
			ID: 9,
			flag: true,
			name: "a",
		})
		expect(createdRecordOf({ data: { other: 1 }, id: 1, name: "a" }, "id", sent)).toEqual({
			data: { other: 1 },
			id: 1,
			name: "a",
		})
		expect(createdRecordOf([1], "id", sent)).toEqual({})
		expect(createdRecordOf({ data: { name: "a" } }, "id", "not a record")).toEqual({ data: { name: "a" } })
	})

	it("gives an enveloped record the envelope's identity, or its id, when it lacks one", () => {
		const sent = { name: "a" }
		expect(createdRecordOf({ data: { name: "a" }, row_id: "r1" }, "row_id", sent)).toEqual({ name: "a", row_id: "r1" })
		expect(createdRecordOf({ id: 4, item: { name: "a" } }, "row_id", sent)).toEqual({ name: "a", row_id: 4 })
		expect(createdRecordOf({ id: null, result: { name: "a" } }, "row_id", sent)).toEqual({ name: "a" })
	})
})

const resolve = (body: unknown, source = NONE, identity = "id") =>
	resolveCreatedId({ body, entity: "row", identity, sent: { name: "a" }, source })

describe("resolveCreatedId", () => {
	it("trusts a declared id, then the answer's own identity", () => {
		const declared = { createdIdFrom: "$.meta.key", recordPath: null }
		expect(resolve({ id: 1, meta: { key: "k" } }, declared)).toEqual({ id: "k", trusted: true, value: "k" })
		expect(resolve({ id: 1, meta: {} }, declared)).toEqual({ id: "1", trusted: true, value: 1 })
	})

	it("takes the declared record's identity as a candidate", () => {
		const source = { createdIdFrom: null, recordPath: "$.payload" }
		expect(resolve({ payload: { id: "p1" } }, source)).toEqual({ id: "p1", trusted: false, value: "p1" })
		expect(resolve({ payload: "p1", row_id: "r2" }, source)).toEqual({ id: "r2", trusted: false, value: "r2" })
		expect(resolve({ payload: {}, row_id: "r3" }, source)).toEqual({ id: "r3", trusted: false, value: "r3" })
	})

	it("falls back to an enveloped record, then to a conventional key anywhere in the answer", () => {
		expect(resolve({ data: { name: "a", uid: "u1" }, ok: true }, NONE, "uid")).toEqual({
			id: "u1",
			trusted: false,
			value: "u1",
		})
		expect(resolve([{ row_id: "r4" }])).toEqual({ id: "r4", trusted: false, value: "r4" })
		expect(resolve({ ok: true })).toBeUndefined()
	})
})

const ITEM = "/v1/projects/{project_id}/tables/{table_id}"

describe("locatedId", () => {
	it("reads the id from an absolute or a relative Location, past a trailing slash, query and fragment", () => {
		expect(locatedId("https://api.test/v1/projects/p1/tables/t9", ITEM)).toBe("t9")
		expect(locatedId("/v1/projects/p1/tables/t9/", ITEM)).toBe("t9")
		expect(locatedId("/v1/projects/p1/tables/t9?expand=rows#top", ITEM)).toBe("t9")
		expect(locatedId("tables/t%209", ITEM, "https://api.test/v1/projects/p1/")).toBe("t 9")
	})

	it("aligns the Location with the item route from its end, under any mount", () => {
		expect(locatedId("https://kc.test/admin/realms/master/users/u-1", "/{realm}/users/{id}")).toBe("u-1")
		expect(locatedId("/api/v1/projects/p1/tables/t9", ITEM)).toBe("t9")
		expect(locatedId("/v1/users/u1/profile", "/users/{id}/profile")).toBe("u1")
	})

	it("names nothing for a Location the item route does not match, or none at all", () => {
		expect(locatedId("/v1/projects/p1/jobs/j1", ITEM)).toBeUndefined()
		expect(locatedId("/profile", "/users/{id}/profile")).toBeUndefined()
		expect(locatedId("/", ITEM)).toBeUndefined()
		expect(locatedId(undefined, ITEM)).toBeUndefined()
		expect(locatedId("http://[bad", ITEM)).toBeUndefined()
	})

	it("is the last segment when there is no item route to resolve it against", () => {
		expect(locatedId("/v1/things/42", undefined)).toBe("42")
		expect(locatedId("/v1/things/%E0%A4%A", undefined)).toBe("%E0%A4%A")
	})
})

const createOpOf = (over: Partial<OperationModel> = {}): OperationModel =>
	({ createdIdFrom: null, entity: "table", operationId: "table.create", recordPath: null, ...over }) as never
const routeNames = (routes: Record<string, string>) =>
	Object.fromEntries(Object.keys(routes).map((id) => [id.split(".")[1], id]))
const modelWith = (routes: Record<string, string>): SpecModel =>
	({
		byOperationId: new Map(Object.entries(routes).map(([id, path]) => [id, { operationId: id, path }])),
		entities: new Map([["table", { identity: "table_id", name: "table", ...routeNames(routes) }]]),
	}) as never
const answer = (responseBody: unknown, location?: string) => ({
	responseBody,
	responseHeaders: location === undefined ? {} : { Location: location },
	url: "https://api.test/v1/projects/p1/tables",
})

describe("createdIdOf", () => {
	it("takes the body's id first, then the Location the item route resolves", () => {
		const routes = modelWith({ "table.read": ITEM })
		const located = answer(null, "/v1/projects/p1/tables/t2")
		expect(
			createdIdOf({ createOp: createOpOf(), exchange: answer({ table_id: "t1" }, "/x/t2"), model: routes, sent: {} }),
		).toEqual({ id: "t1", trusted: true, value: "t1" })
		expect(createdIdOf({ createOp: createOpOf(), exchange: located, model: routes, sent: {} })).toEqual({
			id: "t2",
			trusted: true,
			value: "t2",
		})
	})

	it("resolves Location against the delete, then the update, route when there is no read", () => {
		const del = modelWith({ "table.delete": ITEM })
		const upd = modelWith({ "table.update": "/v1/projects/{project_id}/tables/{table_id}/meta" })
		expect(
			createdIdOf({ createOp: createOpOf(), exchange: answer("", "/v1/projects/p1/tables/t3"), model: del, sent: {} })
				?.value,
		).toBe("t3")
		expect(
			createdIdOf({
				createOp: createOpOf(),
				exchange: answer("", "/v1/projects/p1/tables/t4/meta"),
				model: upd,
				sent: {},
			})?.value,
		).toBe("t4")
		expect(createdIdOf({ createOp: createOpOf(), exchange: answer(""), model: del, sent: {} })).toBeUndefined()
	})

	it("reads Location as the last segment for an operation no entity owns", () => {
		const exchange = answer(undefined, "/v1/projects/p1/things/k5")
		expect(
			createdIdOf({ createOp: createOpOf({ entity: null }), exchange, model: modelWith({}), sent: {} })?.value,
		).toBe("k5")
	})
})

describe("answeredIdOf", () => {
	const model = {
		byOperationId: new Map([["table.read", { operationId: "table.read", path: ITEM }]]),
		entities: new Map([["table", { identity: "table_id", name: "table", read: "table.read" }]]),
	} as never as SpecModel
	const createOp = { entity: "table" } as OperationModel
	const answered = (responseBody: unknown, headers: Record<string, string> = {}) =>
		answeredIdOf({
			createOp,
			exchange: { requestBody: { name: "a" }, responseBody, responseHeaders: headers, url: "https://api.test/t" },
			identity: "table_id",
			model,
		})

	it("is the answered record's identity, enveloped or not, and never a related record's", () => {
		expect(answered({ table_id: 5 })).toBe(5)
		expect(answered({ data: { name: "a" }, table_id: "t5" })).toBe("t5")
		expect(answered({ Status: { table_id: "s1" }, name: "a" })).toBeUndefined()
	})

	it("falls back to the id the Location names, and is undefined with neither", () => {
		expect(answered(null, { location: "/v1/projects/p1/tables/t6" })).toBe("t6")
		expect(answered({ table_id: null }, {})).toBeUndefined()
	})
})
