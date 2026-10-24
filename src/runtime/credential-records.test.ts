import { describe, expect, it } from "vitest"
import type { SpecModel } from "../spec/graph/types.ts"
import { heldCredential, mintedRecords } from "./credential-records.ts"
import type { Exchange } from "./exchange.ts"

/*
 * A record that holds a live credential the run depends on, a minted API key say, is known by the
 * mint answer that made it: its id read the way every created id is, from the body by the entity's
 * identity or from Location. A check may read such a record; it may never change or remove it.
 */

const KEY_OPS = [
	{ action: "create", entity: "api-key", method: "POST", operationId: "apiKey.create", path: "/keys", pathParams: [] },
	{
		action: "read",
		entity: "api-key",
		method: "GET",
		operationId: "apiKey.get",
		path: "/keys/{id}",
		pathParams: ["id"],
	},
	{
		action: "delete",
		entity: "api-key",
		method: "DELETE",
		operationId: "apiKey.revoke",
		path: "/keys/{id}",
		pathParams: ["id"],
	},
	{
		action: "delete",
		entity: "table",
		method: "DELETE",
		operationId: "table.delete",
		path: "/tables/{id}",
		pathParams: ["id"],
	},
	{ action: null, entity: null, method: "POST", operationId: "token.mint", path: "/tokens", pathParams: [] },
].map((op) => ({ ...op, createdIdFrom: null, recordPath: null }))
const MODEL = {
	byOperationId: new Map(KEY_OPS.map((op) => [op.operationId, op])),
	entities: new Map([
		["api-key", { identity: "id", name: "api-key", read: "apiKey.get" }],
		["table", { identity: "id", name: "table" }],
	]),
	operations: KEY_OPS,
} as unknown as SpecModel

const minted = (body: unknown, extra: Partial<Exchange> = {}): Exchange =>
	({
		issuedBy: "credentials",
		operationId: "apiKey.create",
		requestBody: { scopes: ["t:read"] },
		responseBody: body,
		responseHeaders: {},
		status: 201,
		url: "http://api.test/keys",
		...extra,
	}) as Exchange

describe("mintedRecords", () => {
	it("knows each record a credential recipe minted, by the id its answer or Location gives", () => {
		const exchanges = [
			minted({ id: "k-1", key: "ak_1" }),
			minted({ key: "ak_2" }, { responseHeaders: { location: "http://api.test/keys/k-2" } }),
		]
		expect(mintedRecords({ exchanges, mintOps: new Set(["apiKey.create"]), model: MODEL })).toEqual([
			{ entity: "api-key", id: "k-1", operationId: "apiKey.create" },
			{ entity: "api-key", id: "k-2", operationId: "apiKey.create" },
		])
	})

	it("leaves out what no recipe minted, a refused mint, and an answer that names no id", () => {
		const { issuedBy: _byTheStore, ...unissued } = minted({ id: "k-3" })
		const exchanges = [
			unissued as Exchange,
			minted({ id: "k-4" }, { status: 400 }),
			minted({ key: "ak_5" }),
			minted({ id: "t-1" }, { operationId: "table.create" }),
			minted({ id: "x-1" }, { operationId: "token.mint" }),
			minted({ id: "x-2" }, { operationId: "gone.mint" }),
		]
		/* A mint the document places in no entity, or no operation at all, holds no record oat can name. */
		const mintOps = new Set(["apiKey.create", "token.mint", "gone.mint"])
		expect(mintedRecords({ exchanges, mintOps, model: MODEL })).toEqual([])
	})
})

const op = (id: string) => MODEL.byOperationId.get(id) as never

describe("heldCredential", () => {
	const held = [{ entity: "api-key", id: "k-1", operationId: "apiKey.create" }]

	it("is the record a request names by its resolved path, on the minted record's own entity", () => {
		expect(heldCredential(op("apiKey.revoke"), { id: "k-1" }, held)).toEqual(held[0])
	})

	it("is nothing for another id, another entity's record under the same id, or no path at all", () => {
		expect(heldCredential(op("apiKey.revoke"), { id: "k-2" }, held)).toBeUndefined()
		expect(heldCredential(op("table.delete"), { id: "k-1" }, held)).toBeUndefined()
		expect(heldCredential(op("apiKey.create"), {}, held)).toBeUndefined()
	})
})
