import { describe, expect, it } from "vitest"
import { exchangeOf } from "../checks/__fixtures__/harness.ts"
import { runContractCalls } from "./calls.ts"
import { madeByRun } from "./made-by-run.ts"
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
		expect(sent.map((request) => request.options.as)).toEqual(Array.from({ length: 3 }, () => ({ principal: "alpha" })))
		expect(sent[0]?.options).not.toHaveProperty("query")
		expect(sent[0]?.options).not.toHaveProperty("body")
		expect([...(input.grades.needs.get("things.get") ?? [])]).toEqual([
			"unresolved param thing_id: no response this run saw carried one, and hooks.resolvePathValue did not answer",
		])
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
				{ method: "GET", options: { as: { principal: "alpha" }, operationId: "things.list" }, path: "/things" },
				{ body: [], status: 200 },
			),
		)
		await runContractCalls(input)
		expect(sent).toEqual([])
		expect(input.grades.evidence.has("things.list")).toBe(true)
	})
})

describe("runContractCalls and declared styles", () => {
	it("fills a path in its declared style, and never sends a TRACE, naming why", async () => {
		const styled = doc({
			"/m{v}": {
				get: {
					operationId: "m.get",
					parameters: [{ ...pathParam("v", { enum: ["red"] }), style: "matrix" }],
					responses: ok(),
				},
				trace: { operationId: "m.trace", responses: ok() },
			},
		})
		const { input, sent } = stage(styled, () => ({ status: 200 }))
		await runContractCalls(input)
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /m;v=red"])
		expect([...(input.grades.needs.get("m.trace") ?? [])]).toEqual([
			"fetch refuses TRACE (a cross-site tracing guard), so oat lists the operation but never sends it",
		])
	})
})

describe("runContractCalls and security probes", () => {
	it("never takes a security probe's success for the operation's contract call, and calls it itself", async () => {
		const { input, sent } = stage(things, () => ({ status: 200 }), {
			mode: "targeted",
			inScope: (id) => id === "things.list",
		})
		const probe = { as: { anonymous: true }, operationId: "things.list", probe: true } as const
		input.client.transcript.push(
			exchangeOf({ method: "GET", options: probe, path: "/things" }, { body: [], status: 200 }),
		)
		await runContractCalls(input)
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /things"])
	})

	it("still calls an operation only security probes graded", async () => {
		const { input, sent } = stage(things, () => ({ status: 200 }), {
			mode: "targeted",
			inScope: (id) => id === "things.list",
		})
		input.grades.probedBy(["things.list"], "auth.anonymous-operation-open")
		await runContractCalls(input)
		expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /things"])
	})
})

describe("runContractCalls and credential operations", () => {
	it("sends a credential operation as the actor the credentials give, never the principal", async () => {
		const { input, sent } = stage(things, () => ({ body: [], status: 200 }), {
			credentials: {
				actorFor: async (op) => ({ as: { principal: `alpha#probe-1 for ${op.operationId}`, scheme: "jwt" } }),
				identityFields: new Map(),
				operations: new Set(["things.list"]),
			},
			inScope: (id) => id === "things.list" || id === "things.search",
			mode: "targeted",
		})
		await runContractCalls(input)
		expect(sent.map((request) => [request.path, request.options.as])).toEqual([
			["/things", { principal: "alpha#probe-1 for things.list", scheme: "jwt" }],
			["/search", { principal: "alpha" }],
		])
	})

	it("leaves a credential operation untested, with the reason, when no actor can send it", async () => {
		const { input, sent } = stage(things, () => ({ status: 200 }), {
			credentials: {
				actorFor: async () => ({ untested: "static recipes cannot issue a dedicated credential" }),
				identityFields: new Map(),
				operations: new Set(["things.list"]),
			},
			inScope: (id) => id === "things.list",
			mode: "targeted",
		})
		await runContractCalls(input)
		expect(sent).toEqual([])
		expect([...(input.grades.needs.get("things.list") ?? [])]).toEqual([
			"static recipes cannot issue a dedicated credential",
		])
	})
})

/* A sign-in whose document examples name a real-looking account, which failed attempts could lock. */
const signIn = doc({
	"/auth/login": {
		post: {
			operationId: "auth.login",
			requestBody: json({
				properties: {
					client: { type: "string" },
					email: { enum: ["admin@company.com"], example: "admin@company.com", format: "email", type: "string" },
					password: { example: "Admin123!", type: "string" },
				},
				required: ["client", "email", "password"],
				type: "object",
			}),
			responses: ok({ properties: { token: { type: "string" } }, type: "object" }),
			security: [],
		},
	},
})

const signInCredentials = {
	actorFor: async () => ({ as: { anonymous: true } as const }),
	identityFields: new Map([["auth.login", [["email"], ["password"]]]]),
	operations: new Set(["auth.login"]),
}

describe("runContractCalls and sign-in operations", () => {
	it("signs in as an identity no account holds, never a documented example account", async () => {
		const bodyOf = async (identityFields: typeof signInCredentials.identityFields) => {
			const { input, sent } = stage(signIn, () => ({ status: 401 }), {
				credentials: { ...signInCredentials, identityFields },
			})
			await runContractCalls(input)
			expect(sent).toHaveLength(1)
			return sent[0]?.options.body as Record<string, unknown>
		}
		const generated = await bodyOf(new Map())
		expect(generated["email"]).toBe("admin@company.com")
		const body = await bodyOf(signInCredentials.identityFields)
		expect(JSON.stringify(body)).not.toContain("admin@company.com")
		expect(body).toEqual({
			client: generated["client"],
			email: "oat-nonexistent-n0@example.invalid",
			password: "oat-nonexistent-n0",
		})
	})

	it("takes the store's own sign-in as its contract evidence: no second call, and still judged", async () => {
		const { input, sent } = stage(signIn, () => ({ status: 200 }), { credentials: signInCredentials })
		const login = { as: { anonymous: true }, body: { email: "a@x.test" }, operationId: "auth.login" } as const
		input.client.transcript.push(
			exchangeOf({ method: "POST", options: login, path: "/auth/login" }, { body: { token: "t" }, status: 200 }),
		)
		await runContractCalls(input)
		expect(sent).toEqual([])
		expect(input.grades.judged("auth.login")).toBe(true)
		expect(input.grades.evidence.has("auth.login")).toBe(true)
	})
})

/* Records the API already held, listed, and a delete that would remove one. */
const held = doc({
	"/records": { get: { operationId: "records.list", responses: ok({ items: item, type: "array" }) } },
	"/records/{id}": { delete: { operationId: "records.delete", parameters: [pathParam("id")], responses: ok() } },
})

describe("runContractCalls and records the run did not make", () => {
	it("never sends a write to a record only a list showed: it is left untested, and nothing is sent", async () => {
		const { input, sent } = stage(held, () => ({ body: [{ id: "bystander" }], status: 200 }), {
			inScope: (id) => id === "records.delete",
			madeByRun: () => false,
			mode: "targeted",
		})
		input.client.transcript.push(
			exchangeOf(
				{ method: "GET", options: { as: { principal: "alpha" }, operationId: "records.list" }, path: "/records" },
				{ body: [{ id: "bystander" }], status: 200 },
			),
		)
		await runContractCalls(input)
		expect(sent).toEqual([])
		expect([...(input.grades.needs.get("records.delete") ?? [])]).toEqual([
			"unresolved param id: a write is sent only to a record this run created",
		])
	})
})

/* Keys the credential store mints, and the revoke the floor would call. */
const minted = doc({
	"/keys": { post: { operationId: "keys.create", responses: { "201": { description: "made" } } } },
	"/keys/{id}": { delete: { operationId: "keys.revoke", parameters: [pathParam("id")], responses: ok() } },
})

describe("runContractCalls and the credentials the store holds", () => {
	it("never revokes a key the store holds live for a principal, when no key the run made was revoked", async () => {
		const { input, model, sent } = stage(minted, () => ({ status: 200 }), {
			inScope: (id) => id === "keys.revoke",
			mode: "targeted",
		})
		const mint = exchangeOf(
			{ method: "POST", options: { as: { principal: "alpha" }, operationId: "keys.create" }, path: "/keys" },
			{ body: { id: "key_alpha", key: "v-alpha" }, status: 201 },
		)
		input.client.transcript.push({ ...mint, issuedBy: "credentials" })
		const alpha = {
			credential: { expiresAt: null, value: "v-alpha" },
			principal: "alpha",
			scheme: "apiKey",
			scopes: [],
		}
		input.madeByRun = madeByRun({ client: input.client, held: [alpha as never], ledger: { holds: () => false }, model })
		await runContractCalls(input)
		expect(sent).toEqual([])
		expect([...(input.grades.needs.get("keys.revoke") ?? [])]).toEqual([
			"unresolved param id: a write is sent only to a record this run created",
		])
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
