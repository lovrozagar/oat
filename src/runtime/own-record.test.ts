import { describe, expect, it } from "vitest"
import { Client } from "../client/client.ts"
import { json, transport } from "../client/__fixtures__/transport.ts"
import { Redactor } from "../security/redact.ts"
import type { RequestOptions } from "../client/types.ts"
import { probeOwner } from "../credentials/probe-principal.ts"
import type { SpecModel } from "../spec/graph/types.ts"
import type { Exchange } from "./exchange.ts"
import {
	guardedClient,
	ownRecordsFrom,
	guardWrite,
	HeldRecordError,
	type OwnRecords,
	ownRecord,
	protectedFields,
	ProtectedWriteError,
	type Write,
} from "./own-record.ts"

const op = (method: string, path: string, more: { identity?: string; pathParams?: string[] } = {}) => ({
	identity: more.identity ?? null,
	method,
	path,
	pathParams: more.pathParams ?? [],
})

const identity = { email: "ann@x.io", id: "u-1", password: "pw", uid: 2 }
const signIn = new Set(["email", "Password", "handle"])

const selfWrite: Write = { identity, op: op("PATCH", "/me", { identity: "self" }), path: {} }
const otherWrite: Write = { identity, op: op("PUT", "/tables/{id}", { pathParams: ["id"] }), path: { id: "t-9" } }

describe("ownRecord", () => {
	it("is the self record, a write that names no record, or one whose path names the principal", () => {
		expect(ownRecord(selfWrite)).toBe(true)
		expect(ownRecord({ identity, op: op("POST", "/me", { identity: "self" }), path: {} })).toBe(true)
		expect(ownRecord({ identity, op: op("PUT", "/users/me"), path: {} })).toBe(true)
		expect(ownRecord({ identity, op: op("DELETE", "/session"), path: {} })).toBe(true)
		expect(ownRecord({ ...otherWrite, path: { id: "u-1" } })).toBe(true)
		expect(ownRecord({ ...otherWrite, path: { id: "2" } })).toBe(true)
	})

	it("is not a create, another record, or a read", () => {
		expect(ownRecord({ identity, op: op("POST", "/tables"), path: {} })).toBe(false)
		expect(ownRecord(otherWrite)).toBe(false)
		expect(ownRecord({ identity, op: op("GET", "/me", { identity: "self" }), path: {} })).toBe(false)
		expect(ownRecord({ ...otherWrite, identity: { profile: { id: "t-9" } } })).toBe(false)
	})
})

describe("protectedFields", () => {
	const fields = ["first_name", "email", "password", "newPassword", "api_key", "HANDLE", "note"]

	it("is every credential-named field and every one the principal signs in with, on its own record", () => {
		expect([...protectedFields(signIn, selfWrite, fields)].toSorted()).toEqual([
			"HANDLE",
			"api_key",
			"email",
			"newPassword",
			"password",
		])
	})

	it("is nothing on another record", () => {
		expect(protectedFields(signIn, otherWrite, fields).size).toBe(0)
	})
})

describe("guardWrite", () => {
	const schema = {
		properties: {
			email: { format: "email", type: "string" },
			first_name: { type: "string" },
			profile: {
				properties: { password: { type: "string" }, theme: { type: "string" } },
				type: "object",
			},
		},
		type: "object",
	}

	it("drops the protected fields of a write to the principal's own record, deep", () => {
		const body = { email: "e@x.io", first_name: "Oat", profile: { password: "p", theme: "dark" } }
		expect(guardWrite(signIn, selfWrite, { body, schema })).toEqual({
			body: { first_name: "Oat", profile: { theme: "dark" } },
			dropped: ["email", "profile.password"],
		})
		/* The body it was given is not changed. */
		expect(body.profile.password).toBe("p")
	})

	it("names a protected field the schema requires: the write needs it", () => {
		const body = { email: "e@x.io", first_name: "Oat", profile: { password: "p" } }
		const profile = { ...schema.properties.profile, required: ["password"] }
		const strict = { ...schema, properties: { ...schema.properties, profile }, required: ["email"] }
		expect(guardWrite(signIn, selfWrite, { body, schema: strict })).toEqual({
			needs: ["email", "profile.password"],
		})
	})

	it("sends another record's body as it was built, and a body that is no object", () => {
		const body = { email: "e@x.io", password: "p" }
		expect(guardWrite(signIn, otherWrite, { body, schema })).toEqual({ body, dropped: [] })
		expect(guardWrite(signIn, selfWrite, { body: undefined })).toEqual({ body: undefined, dropped: [] })
		expect(guardWrite(signIn, selfWrite, { body: [{ password: "p" }] })).toEqual({
			body: [{ password: "p" }],
			dropped: [],
		})
	})

	it("drops without a schema to read, and needs nothing then", () => {
		expect(guardWrite(signIn, selfWrite, { body: { password: "p", note: "n" } })).toEqual({
			body: { note: "n" },
			dropped: ["password"],
		})
	})
})

describe("guardedClient", () => {
	const ops = [
		{ identity: null, method: "PATCH", operationId: "me.update", path: "/users/me", pathParams: [] },
		{ identity: null, method: "PATCH", operationId: "user.update", path: "/users/{id}", pathParams: ["id"] },
		{ identity: null, method: "GET", operationId: "me.get", path: "/users/me", pathParams: [] },
	].map((one) => ({ ...one, statuses: { exact: [200], ranges: [] } }))
	const model = {
		byOperationId: new Map(ops.map((one) => [one.operationId, one])),
		operations: ops,
	} as unknown as SpecModel
	const records: OwnRecords = {
		disposable: () => Promise.resolve({ blocked: "no signup" }),
		identityOf: (principal) => (probeOwner(principal) === "alpha" ? identity : undefined),
		signIn,
	}

	function staged() {
		const sent: Array<[string, string, unknown]> = []
		const client = {
			request: (method: string, path: string, options: RequestOptions) => {
				sent.push([method, path, options.body])
				return Promise.resolve({ status: 200 } as Exchange)
			},
			view: () => client,
		} as unknown as Client
		return { client: guardedClient(client, records, model), sent }
	}

	it("refuses a write that would change a protected field of the sender's own record, sending nothing", async () => {
		const { client, sent } = staged()
		const write = client.request("PATCH", "/users/me", { as: { principal: "alpha" }, body: { email: "e", note: "n" } })
		await expect(write).rejects.toThrow(ProtectedWriteError)
		await expect(write).rejects.toThrow(
			"me.update would change email on alpha's own record, which alpha signs in with: oat never sends that",
		)
		await expect(
			client.view({}).request("PATCH", "/users/u-1", { as: { principal: "alpha#probe-1" }, body: { password: "p" } }),
		).rejects.toThrow("user.update would change password on alpha's own record")
		expect(sent).toEqual([])
	})

	it("sends another record's write, a disposable's, an anonymous one, a read and an unknown route", async () => {
		const { client, sent } = staged()
		await client.request("PATCH", "/users/u-2", { as: { principal: "alpha" }, body: { password: "p" } })
		await client.request("PATCH", "/users/me", { as: { principal: "disposable-0" }, body: { password: "p" } })
		await client.request("PATCH", "/users/me", { as: { anonymous: true }, body: { password: "p" } })
		await client.request("PATCH", "/users/me", { as: { principal: "alpha" }, body: { note: "n" } })
		await client.request("GET", "/users/me", { as: { principal: "alpha" } })
		await client.request("PATCH", "/elsewhere", { as: { principal: "alpha" }, body: { password: "p" } })
		expect(sent.map(([method, path]) => `${method} ${path}`)).toEqual([
			"PATCH /users/u-2",
			"PATCH /users/me",
			"PATCH /users/me",
			"PATCH /users/me",
			"GET /users/me",
			"PATCH /elsewhere",
		])
	})
})

const REACH_OPS = [
	{ identity: "self", method: "GET", operationId: "me.get", path: "/me", pathParams: [] },
	{ identity: null, method: "PATCH", operationId: "me.update", path: "/users/me", pathParams: [] },
	{ identity: null, method: "PATCH", operationId: "user.update", path: "/users/{id}", pathParams: ["id"] },
].map((one) => ({ ...one, statuses: { exact: [200], ranges: [] } }))
const REACH_MODEL = {
	byOperationId: new Map(REACH_OPS.map((one) => [one.operationId, one])),
	operations: REACH_OPS,
} as unknown as SpecModel
/* alpha's config names only how it signs in: its own server-side id is learned from the self read. */
const learning = (): OwnRecords =>
	ownRecordsFrom({
		disposable: () => Promise.resolve({ blocked: "no signup" }),
		identityOf: (principal) => (probeOwner(principal) === "alpha" ? { email: "ann@x.io" } : undefined),
		signIn: new Set(["email"]),
	})

describe("guardedClient's reach", () => {
	it("refuses a protected field however deep the body nests it", async () => {
		const sent: string[] = []
		const inner = {
			request: (m: string, p: string) => (sent.push(`${m} ${p}`), Promise.resolve({} as Exchange)),
			view: () => inner,
		}
		const client = guardedClient(inner as unknown as Client, learning(), REACH_MODEL)
		for (const body of [{ user: { password: "p" } }, { data: { attributes: { email: "e" } } }]) {
			await expect(client.request("PATCH", "/users/me", { as: { principal: "alpha" }, body })).rejects.toThrow(
				ProtectedWriteError,
			)
		}
		expect(sent).toEqual([])
	})

	it("learns the principal's own id from its self read, and guards a write to that record", async () => {
		const answers = new Map([["GET /me", { id: "u-9", name: "Ann" }]])
		const inner = {
			request: (method: string, path: string) =>
				Promise.resolve({ responseBody: answers.get(`${method} ${path}`), status: 200 } as unknown as Exchange),
			view: () => inner,
		}
		const client = guardedClient(inner as unknown as Client, learning(), REACH_MODEL)
		await client.request("GET", "/me", { as: { principal: "alpha" } })
		await expect(
			client.request("PATCH", "/users/u-9", { as: { principal: "alpha" }, body: { password: "p" } }),
		).rejects.toThrow("user.update would change password on alpha's own record")
		await expect(
			client.request("PATCH", "/users/u-8", { as: { principal: "alpha" }, body: { password: "p" } }),
		).resolves.toBeDefined()
	})
})

describe("guardedClient learning and every way it sends", () => {
	it("learns nothing for a principal it does not guard, or from an answer that is no record", () => {
		const guard = learning()
		guard.learn?.("disposable-0", { id: "d-1" })
		guard.learn?.("alpha", "u-9")
		guard.learn?.("alpha", { id: "u-9", name: "Ann", project_id: "p-1", tags: ["x"], user_id: 4 })
		expect(guard.identityOf("disposable-0")).toBeUndefined()
		/* A foreign key names the tenant, not the caller's own record. */
		expect(guard.identityOf("alpha")).toEqual({ email: "ann@x.io", id: "u-9", user_id: 4 })
	})

	it("refuses through every way a real client sends: request, its views, and views of views", async () => {
		const wire = transport(() => json({}))
		const real = new Client({
			baseUrl: "http://api.test",
			network: { fetchImpl: wire.fetch },
			redactor: new Redactor(),
		})
		const client = guardedClient(real, learning(), REACH_MODEL)
		const write = { as: { principal: "alpha" }, body: { email: "e" } } as const
		const senders = [
			() => client.request("PATCH", "/users/me", write),
			() => client.view({}).request("PATCH", "/users/me", write),
			() => client.view({}).view({}).request("PATCH", "/users/me", write),
			() => (client.readOnlyView({}) as unknown as Client).request("PATCH", "/users/me", write),
		]
		for (const send of senders) await expect(send()).rejects.toThrow(/would change email|does not mutate/)
		expect(wire.sent).toEqual([])
	})
})

const HELD_OPS = [
	{
		entity: "api-key",
		identity: null,
		method: "PATCH",
		operationId: "apiKey.update",
		path: "/keys/{id}",
		pathParams: ["id"],
	},
	{
		entity: "api-key",
		identity: null,
		method: "DELETE",
		operationId: "apiKey.revoke",
		path: "/keys/{id}",
		pathParams: ["id"],
	},
	{
		entity: "api-key",
		identity: null,
		method: "GET",
		operationId: "apiKey.get",
		path: "/keys/{id}",
		pathParams: ["id"],
	},
	{
		entity: "user",
		identity: null,
		method: "DELETE",
		operationId: "user.delete",
		path: "/users/{id}",
		pathParams: ["id"],
	},
	{
		entity: "user",
		identity: null,
		method: "PUT",
		operationId: "user.replace",
		path: "/users/{id}",
		pathParams: ["id"],
	},
].map((one) => ({ ...one, statuses: { exact: [200], ranges: [] } }))
const HELD_MODEL = {
	byOperationId: new Map(HELD_OPS.map((one) => [one.operationId, one])),
	operations: HELD_OPS,
} as unknown as SpecModel
const HELD: OwnRecords = {
	credentials: () => [{ entity: "api-key", id: "k-1", operationId: "apiKey.create" }],
	disposable: () => Promise.resolve({ blocked: "no signup" }),
	identityOf: (principal) => (probeOwner(principal) === "alpha" ? identity : undefined),
	signIn,
}

function heldStage() {
	const sent: string[] = []
	const inner = {
		request: (method: string, path: string) => (sent.push(`${method} ${path}`), Promise.resolve({} as Exchange)),
		view: () => inner,
	}
	return { client: guardedClient(inner as unknown as Client, HELD, HELD_MODEL), sent }
}

describe("guardedClient and the credentials the run holds", () => {
	it("refuses a change or removal of a credential record the run holds, whoever sends it, sending nothing", async () => {
		const { client, sent } = heldStage()
		await expect(client.request("DELETE", "/keys/k-1", { as: { principal: "beta" } })).rejects.toThrow(
			"apiKey.revoke would change api-key k-1, a credential the run holds (minted by apiKey.create): oat never sends that",
		)
		await expect(
			client.request("PATCH", "/keys/k-1", { as: { principal: "alpha" }, body: { name: "n" } }),
		).rejects.toThrow(ProtectedWriteError)
		await expect(client.request("DELETE", "/keys/k-1", { as: { anonymous: true } })).rejects.toThrow(
			ProtectedWriteError,
		)
		expect(sent).toEqual([])
	})

	it("reads a credential record, and changes a record the run made for its checks", async () => {
		const { client, sent } = heldStage()
		await client.request("GET", "/keys/k-1", { as: { principal: "alpha" } })
		await client.request("GET", "/keys/k-1", { as: { anonymous: true } })
		await client.request("DELETE", "/keys/k-2", { as: { principal: "beta" } })
		await client.request("PATCH", "/keys/k-2", { as: { principal: "alpha" }, body: { name: "n" } })
		expect(sent).toEqual(["GET /keys/k-1", "GET /keys/k-1", "DELETE /keys/k-2", "PATCH /keys/k-2"])
	})
})

describe("guardedClient and a principal's own record", () => {
	it("refuses to remove or replace a configured principal's own record, and lets a disposable's go", async () => {
		const { client, sent } = heldStage()
		await expect(client.request("DELETE", "/users/u-1", { as: { principal: "alpha" } })).rejects.toThrow(
			"user.delete would remove alpha's own record: oat never sends that",
		)
		await expect(
			client.request("PUT", "/users/u-1", { as: { principal: "alpha" }, body: { note: "n" } }),
		).rejects.toThrow(
			"user.replace is a full replace of alpha's own record, which could clear its sign-in fields: oat never sends that",
		)
		await expect(client.request("DELETE", "/users/u-1", { as: { principal: "alpha" } })).rejects.toThrow(
			HeldRecordError,
		)
		await client.request("DELETE", "/users/u-1", { as: { principal: "disposable-0" } })
		await client.request("DELETE", "/users/u-2", { as: { principal: "alpha" } })
		expect(sent).toEqual(["DELETE /users/u-1", "DELETE /users/u-2"])
	})
})
