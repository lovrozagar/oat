import { describe, expect, it } from "vitest"
import type { OperationObject } from "../../spec/types.ts"
import { exchange, exchangeOf } from "../checks/__fixtures__/harness.ts"
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

/** An operation whose path parameters come from roots, an enum, the hook and an earlier success. */
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

describe("pathValues", () => {
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
		expect(await pathValues(input, { op, params })).toEqual({
			kind: "red",
			org_id: "o1",
			seen_id: "s1",
			thing_id: "t-hook",
		})
		const told = { identity: {}, principal: "alpha", scope: { org_id: "o1" } }
		expect(asked).toEqual([
			{ enumValues: [], method: "GET", operationId: "deep.get", param: "thing_id", path: op.path, ...told },
			{ enumValues: [], method: "GET", operationId: "deep.get", param: "seen_id", path: op.path, ...told },
		])
	})
})

/* Keys under a bare `{id}`, a usage read beneath one, and jobs: another resource whose records carry `id` too. */
const keyed = {
	"/keys": {
		get: { operationId: "keys.list", responses: ok() },
		post: { operationId: "keys.create", responses: { "201": { description: "made" } } },
	},
	"/keys/{id}": {
		delete: { operationId: "keys.revoke", parameters: [pathParam("id")], responses: ok() },
		get: { operationId: "keys.get", parameters: [pathParam("id")], responses: ok() },
		patch: { operationId: "keys.update", parameters: [pathParam("id")], responses: ok() },
	},
	"/keys/{id}/usage": { get: { operationId: "keys.usage", parameters: [pathParam("id")], responses: ok() } },
	"/projects/{project_id}/jobs": {
		post: { operationId: "jobs.create", parameters: [pathParam("project_id")], responses: ok() },
	},
	"/projects/{project_id}/jobs/{job_id}": {
		delete: { operationId: "jobs.delete", parameters: [pathParam("project_id"), pathParam("job_id")], responses: ok() },
		get: { operationId: "jobs.get", parameters: [pathParam("project_id"), pathParam("job_id")], responses: ok() },
	},
}

/* `operationId`'s DELETE of `path`, answered `status`. */
const deleted = (operationId: string, path: string, status = 200) =>
	exchangeOf({ method: "DELETE", options: { as: { anonymous: true }, operationId }, path }, { status })

/* A success of `operationId` at `path` whose body holds `id`. */
const answered = (operationId: string | undefined, path: string, id: string) =>
	exchangeOf(
		{
			method: "GET",
			options: { as: { anonymous: true }, ...(operationId === undefined ? {} : { operationId }) },
			path,
		},
		{ body: { id }, status: 200 },
	)

describe("pathValues: a bare record key", () => {
	it("draws a bare id only from its own collection or items, never another resource's newest record", async () => {
		const { input, op, params } = staged(keyed, "keys.get")
		input.client.transcript.push(
			answered("keys.create", "/keys", "key_1"),
			answered("keys.usage", "/keys/key_1/usage", "usage_1"),
			answered("jobs.create", "/projects/p1/jobs", "job_1"),
		)
		expect(await pathValues(input, { op, params })).toEqual({ id: "key_1" })
		input.client.transcript.push(answered("keys.get", "/keys/key_2", "key_2"))
		expect(await pathValues(input, { op, params })).toEqual({ id: "key_2" })
	})

	it("leaves a bare id unresolved when only other resources, raw requests or other documents answered one", async () => {
		const { input, op, params } = staged(keyed, "keys.get")
		input.client.transcript.push(
			answered("jobs.create", "/projects/p1/jobs", "job_1"),
			answered(undefined, "/keys", "raw_1"),
			answered("elsewhere.get", "/keys", "other_1"),
		)
		expect(await pathValues(input, { op, params })).toBeNull()
		expect([...(input.grades.needs.get("keys.get") ?? [])]).toEqual([
			"unresolved param id: no response this run saw carried one, and hooks.resolvePathValue did not answer",
		])
	})
})

/* A job create in project p1 whose body names `job` under `job_id`. */
const made = (job: string) =>
	exchangeOf(
		{ method: "POST", options: { as: { anonymous: true }, operationId: "jobs.create" }, path: "/projects/p1/jobs" },
		{ body: { job_id: job }, status: 201 },
	)

describe("pathValues: a live record over a deleted one", () => {
	it("draws an id no later delete removed, over a newer one the run deleted", async () => {
		const { input, op, params } = staged(keyed, "keys.get")
		input.client.transcript.push(
			answered("keys.create", "/keys", "key_1"),
			answered("keys.create", "/keys", "key_2"),
			answered("keys.create", "/keys", "key_3"),
			deleted("keys.revoke", "/keys/key_3"),
			deleted("keys.revoke", "/keys/key_1", 404),
			deleted("jobs.delete", "/projects/p1/jobs/key_2"),
		)
		expect(await pathValues(input, { op, params })).toEqual({ id: "key_2" })
	})

	it("takes a deleted id only when no live one exists", async () => {
		const { input, op, params } = staged(keyed, "keys.get")
		input.client.transcript.push(answered("keys.create", "/keys", "key_1"), deleted("keys.revoke", "/keys/key_1"))
		expect(await pathValues(input, { op, params })).toEqual({ id: "key_1" })
	})

	it("prefers a live record under a qualified name too", async () => {
		const { input, op, params } = staged(keyed, "jobs.get", { roots: { project_id: "p1" } })
		input.client.transcript.push(made("job_1"), made("job_2"), deleted("jobs.delete", "/projects/p1/jobs/job_2"))
		expect(await pathValues(input, { op, params })).toEqual({ job_id: "job_1", project_id: "p1" })
	})
})

/* A list of keys the API already held: records this run did not make. */
const listed = (...ids: string[]) =>
	exchangeOf(
		{ method: "GET", options: { as: { anonymous: true }, operationId: "keys.list" }, path: "/keys" },
		{ body: ids.map((id) => ({ id })), status: 200 },
	)

/* Whether the run made a record: here, exactly `ids`, of the entity each question names. */
function madeOnly(...ids: string[]) {
	const asked = new Set<string>()
	const madeByRun = (entity: string, id: string) => {
		asked.add(entity)
		return ids.includes(id)
	}
	return { asked, madeByRun }
}

describe("pathValues: a write goes only to a record this run made", () => {
	it("draws a record the run made and already deleted over a live foreign one", async () => {
		const ours = madeOnly("key_1", "key_2")
		const { input, op, params } = staged(keyed, "keys.revoke", { madeByRun: ours.madeByRun })
		input.client.transcript.push(
			answered("keys.create", "/keys", "key_1"),
			answered("keys.create", "/keys", "key_2"),
			deleted("keys.revoke", "/keys/key_1"),
			deleted("keys.revoke", "/keys/key_2", 404),
			listed("foreign_1"),
		)
		expect(await pathValues(input, { op, params })).toEqual({ id: "key_1" })
		expect([...ours.asked]).toEqual(["key"])
	})

	it("else a live record the run made, never a foreign one", async () => {
		const { input, op, params } = staged(keyed, "keys.update", { madeByRun: madeOnly("key_2").madeByRun })
		input.client.transcript.push(answered("keys.create", "/keys", "key_2"), listed("foreign_1", "foreign_2"))
		expect(await pathValues(input, { op, params })).toEqual({ id: "key_2" })
	})

	it("leaves a write unresolved when only records the run did not make were seen", async () => {
		for (const operationId of ["keys.revoke", "keys.update"]) {
			const { input, op, params } = staged(keyed, operationId, { madeByRun: madeOnly().madeByRun })
			input.client.transcript.push(listed("foreign_1"), answered("keys.get", "/keys/foreign_2", "foreign_2"))
			expect(await pathValues(input, { op, params })).toBeNull()
			expect([...(input.grades.needs.get(operationId) ?? [])]).toEqual([
				"unresolved param id: a write is sent only to a record this run created",
			])
		}
	})

	it("leaves a write under a parent no route reads unresolved: no entity, so nothing the run made", async () => {
		const { input, op, params } = staged(keyed, "jobs.create", { madeByRun: () => true })
		input.client.transcript.push(
			exchangeOf(
				{ method: "GET", options: { as: { anonymous: true }, operationId: "keys.list" }, path: "/keys" },
				{ body: { project_id: "p1" }, status: 200 },
			),
		)
		expect(await pathValues(input, { op, params })).toBeNull()
		expect([...(input.grades.needs.get("jobs.create") ?? [])]).toEqual([
			"unresolved param project_id: a write is sent only to a record this run created",
		])
	})

	it("names no write rule when no answer showed a value at all", async () => {
		const { input, op, params } = staged(keyed, "keys.revoke", { madeByRun: () => true })
		expect(await pathValues(input, { op, params })).toBeNull()
		expect([...(input.grades.needs.get("keys.revoke") ?? [])]).toEqual([
			"unresolved param id: no response this run saw carried one, and hooks.resolvePathValue did not answer",
		])
	})
})

describe("pathValues: a safe method reads", () => {
	it("draws a QUERY's parameter like a read's, from any record an answer showed", async () => {
		const item = keyed["/keys/{id}"]
		const searchable = {
			...keyed,
			"/keys/{id}": { ...item, query: { operationId: "keys.query", parameters: [pathParam("id")], responses: ok() } },
		}
		const { input, op, params } = staged(searchable, "keys.query", { madeByRun: madeOnly().madeByRun })
		input.client.transcript.push(listed("foreign_1"))
		expect(await pathValues(input, { op, params })).toEqual({ id: "foreign_1" })
	})
})

describe("queryValues: declared objects", () => {
	it("passes a document's object or array value through whole, for its style to write", () => {
		const { input, op, params } = staged(
			queried([
				{ ...query("range", { type: "object" }), example: { max: 5, min: 1 }, style: "deepObject" },
				{ ...query("ids", { items: { type: "string" }, type: "array" }), example: ["a", "b"] },
			]),
			"q.get",
		)
		expect(queryValues(input.grades, { bind: null, op, params })).toEqual({
			ids: ["a", "b"],
			range: { max: 5, min: 1 },
		})
	})
})

describe("pathValues: never a credential", () => {
	it("leaves a parameter unresolved rather than fill it with a token a login answered", async () => {
		const invite = {
			"/invites/{token}": { get: { operationId: "invite.get", parameters: [pathParam("token")], responses: ok() } },
		}
		const { input, op, params } = staged(invite, "invite.get")
		input.client.redactor.registerSecret("acc-9f8e7d6c5b")
		input.client.transcript.push(
			exchange("POST", "/auth/login", {
				body: { refresh_token: "ref-1a2b3c4d5e", token: "acc-9f8e7d6c5b" },
				status: 200,
			}),
		)
		expect(await pathValues(input, { op, params })).toBeNull()
		expect([...(input.grades.needs.get("invite.get") ?? [])]).toEqual([
			"unresolved param token: no response this run saw carried one, and hooks.resolvePathValue did not answer",
		])
	})
})

describe("pathValues: what the hook is told", () => {
	it("tells the hook who acts and what it would send on the operation, never raw headers", async () => {
		const asked: unknown[] = []
		const sends = { cookies: {}, headers: { Authorization: "Bearer jwt-1" }, query: {} }
		const { input, op, params } = staged(paths, "deep.get", {
			acting: {
				identity: { email: "a@x.test" },
				sending: async (operationId) => (operationId === "deep.get" ? { credential: "jwt-1", sends } : undefined),
			},
			hooks: {
				resolvePathValue: async (request) => {
					asked.push(request)
					return "v"
				},
			},
			roots: { org_id: "o1" },
		})
		await pathValues(input, { op, params })
		expect(asked[0]).toEqual({
			credential: "jwt-1",
			enumValues: [],
			identity: { email: "a@x.test" },
			method: "GET",
			operationId: "deep.get",
			param: "thing_id",
			path: op.path,
			principal: "alpha",
			scope: { org_id: "o1" },
			sends,
		})
	})

	it("skips the operation at the first value nothing resolves", async () => {
		const { input, op, params } = staged(paths, "deep.get", {
			hooks: { resolvePathValue: async () => null },
		})
		expect(await pathValues(input, { op, params })).toBeNull()
		expect([...(input.grades.needs.get("deep.get") ?? [])]).toEqual([
			"unresolved param org_id: set it in the principal's scope, or answer it from hooks.resolvePathValue",
		])
	})

	it("works without a hook or a declared parameter", async () => {
		const { input, op } = staged(paths, "deep.get", { roots: { org_id: "o1" } })
		expect(await pathValues(input, { op, params: [] })).toBeNull()
		expect([...(input.grades.needs.get("deep.get") ?? [])]).toEqual([
			"unresolved param kind: set it in the principal's scope, or answer it from hooks.resolvePathValue",
		])
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

describe("bodyOf: a sign-in's identity fields", () => {
	it("puts an identity no account holds at each nested field a sign-in names the principal in", () => {
		const schema = {
			properties: {
				gone: { type: "null" },
				name: { type: "string" },
				profile: {
					properties: { handle: { type: "string" }, locale: { type: "string" } },
					required: ["handle", "locale"],
					type: "object",
				},
				tags: { items: { type: "string" }, type: "array" },
			},
			required: ["gone", "name", "profile", "tags"],
			type: "object",
		}
		const fields = [
			["profile", "handle"],
			["tags", "login"],
			["gone", "login"],
			["account", "email"],
		]
		const credentials = { ...stage(doc({}), () => undefined).input.credentials }
		const { input, op, raw } = staged(post(json(schema)), "p.post", {
			credentials: { ...credentials, identityFields: new Map([["p.post", fields]]) },
		})
		const body = bodyOf(input, { bind: null, op, raw })?.body as Record<string, Record<string, unknown>>
		expect(body).toMatchObject({
			account: { email: "oat-nonexistent-n0@example.invalid" },
			gone: { login: "oat-nonexistent-n0" },
			profile: { handle: "oat-nonexistent-n0" },
			tags: { login: "oat-nonexistent-n0" },
		})
		expect(typeof body["profile"]?.["locale"]).toBe("string")
		expect(body["profile"]?.["locale"]).not.toContain("nonexistent")
	})
})
