import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.ts"
import { type Responder, fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import { FixtureOverflow } from "../fixture.ts"
import { SeedError } from "../seed-error.ts"
import { PAY, tables } from "./__fixtures__/documents.ts"
import { createOne } from "./ancestor-create.ts"
import type { WorldOptions } from "./types.ts"

/* A create refused for both a plan limit and a conflict, with nothing listed to adopt. */
const nothingToAdopt: Responder = (method) =>
	method === "POST" ? { body: { error: "payment_required" }, status: 409 } : { body: [], status: 200 }

/* Creates answer `status` with `body`; the list holds one row to adopt. */
const listed =
	(status: number, body: unknown): Responder =>
	(method) =>
		method === "POST" ? { body, status } : { body: [{ id: "t9" }], status: 200 }

const scope = { created: [], values: { project_id: "p1" } }

function seeding(respond: Responder, table: Record<string, unknown> = {}, options: Partial<WorldOptions> = {}) {
	const model = modelOf(tables(table))
	const fake = fakeClient(respond)
	return {
		createOp: op(model, "table.create"),
		sent: fake.sent,
		seeding: {
			client: fake.client,
			model,
			options: { principal: "alpha", roots: { project_id: "p1" }, seed: 1, ...options },
		},
	}
}

/* A backend that refuses a member's body naming "verified": only its admin may set it. */
const adminSetsVerified: Responder = (method, _path, options) => {
	if (method !== "POST") return undefined
	const named = typeof options.body === "object" && options.body !== null && "verified" in options.body
	return named
		? { body: { message: 'only admin may set "verified"' }, status: 403 }
		: { body: { id: "t1" }, status: 201 }
}

const verifiedBody = (required: string[]) => ({
	requestBody: {
		content: {
			"application/json": {
				schema: {
					properties: { name: { type: "string" }, verified: { type: "boolean", "x-privileged": true } },
					required: ["name", ...required],
					type: "object",
				},
			},
		},
	},
})

/* Withholds every create, as a lower rank's create of a body that requires a privileged property is. */
const barred = () => "table.create requires verified, marked x-privileged"

describe("createOne: a property only the highest rank may set", () => {
	it("leaves an optional x-privileged property out of a member's create, which succeeds", async () => {
		const run = seeding(adminSetsVerified, verifiedBody([]), { principal: "alpha_member" })
		expect(await createOne(run.createOp, run.seeding, scope)).toEqual({ adopted: false, record: { id: "t1" } })
		expect(run.sent[0]?.options.body).not.toHaveProperty("verified")
	})

	it("never sends a create whose body requires one as a principal it withholds, and says why", async () => {
		const run = seeding(adminSetsVerified, verifiedBody(["verified"]), { principal: "alpha_member", withheld: barred })
		await expect(createOne(run.createOp, run.seeding, scope)).rejects.toThrow(
			new SeedError("table.create", "table.create requires verified, marked x-privileged"),
		)
		expect(run.sent).toEqual([])
		const top = seeding(() => ({ body: { id: "t1" }, status: 201 }), verifiedBody(["verified"]), {
			withheld: () => undefined,
		})
		await createOne(top.createOp, top.seeding, scope)
		expect(top.sent[0]?.options.body).toHaveProperty("verified")
	})
})

describe("createOne", () => {
	it("creates the ancestor and reads the record it answers with", async () => {
		const run = seeding((method) => (method === "POST" ? { body: { id: "t1", name: "x" }, status: 201 } : undefined))
		expect(await createOne(run.createOp, run.seeding, scope)).toEqual({
			adopted: false,
			record: { id: "t1", name: "x" },
		})
		expect(run.sent.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /projects/p1/tables"])
		expect(run.sent[0]?.options.as).toEqual({ principal: "alpha" })
		/* Scaffolding carries the nonce in every string. */
		const named = seeding(() => ({ body: { id: "t1" }, status: 201 }), {}, { nonce: "n0", readable: () => true })
		await createOne(named.createOp, named.seeding, scope)
		expect(named.sent[0]?.options.body).toEqual({ name: "Quarterly Report 0 n0" })
	})

	it("keeps unique columns apart from the entity's own cohort", async () => {
		const run = seeding(() => ({ body: { id: "t1" }, status: 201 }), { "x-unique": [["name"]] })
		await createOne(run.createOp, run.seeding, scope)
		const nonced = seeding(() => ({ body: { id: "t1" }, status: 201 }), { "x-unique": [["name"]] }, { nonce: "n0" })
		await createOne(nonced.createOp, nonced.seeding, scope)
		expect(run.sent[0]?.options.body).not.toEqual({ name: "Quarterly Report 0" })
		expect(nonced.sent[0]?.options.body).not.toEqual(run.sent[0]?.options.body)
	})

	it("sends a form body with its content type, and an empty body when the create declares none", async () => {
		const form = {
			requestBody: {
				content: {
					"application/x-www-form-urlencoded": { schema: { properties: { name: { type: "string" } }, type: "object" } },
				},
			},
		}
		const run = seeding(() => ({ body: { id: "t1" }, status: 201 }), form)
		await createOne(run.createOp, run.seeding, scope)
		expect(run.sent[0]?.options.contentType).toBe("application/x-www-form-urlencoded")
		const bare = seeding(() => ({ body: { id: "t2" }, status: 201 }), { requestBody: undefined })
		expect(await createOne(bare.createOp, bare.seeding, scope)).toEqual({ adopted: false, record: { id: "t2" } })
	})

	it("names the operation when no body can be generated, a malformed schema included", async () => {
		const impossible = {
			properties: { n: { maximum: 1, minimum: 5, type: "integer" } },
			required: ["n"],
			type: "object",
		}
		const run = seeding(() => ({ status: 201 }), {
			requestBody: { content: { "application/json": { schema: impossible } } },
		})
		await expect(createOne(run.createOp, run.seeding, scope)).rejects.toThrow(FixtureOverflow)
		await expect(createOne(run.createOp, run.seeding, scope)).rejects.toThrow(/table\.create/)
		const malformed = { allOf: [{ allOf: 5 }] }
		const broken = seeding(() => ({ status: 201 }), {
			requestBody: { content: { "application/json": { schema: malformed } } },
		})
		await expect(createOne(broken.createOp, broken.seeding, scope)).rejects.toThrow(
			/table\.create.*allOf\/0\/allOf is not a list of schemas/,
		)
	})
})

describe("createOne, refused", () => {
	it("adopts a listed record when the plan limit or a unique conflict refuses the create", async () => {
		const limited = seeding(listed(402, { error: "payment_required" }))
		expect(await createOne(limited.createOp, limited.seeding, scope)).toEqual({ adopted: true, record: { id: "t9" } })
		const conflict = seeding(listed(409, { error: "taken" }), { "x-unique": [["name"]] })
		expect(await createOne(conflict.createOp, conflict.seeding, scope)).toEqual({ adopted: true, record: { id: "t9" } })
	})

	it("fails with the refusal when nothing can be adopted", async () => {
		const run = seeding(nothingToAdopt, { "x-unique": [["name"]] })
		const refused = await createOne(run.createOp, run.seeding, scope).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(SeedError)
		expect((refused as SeedError).message).toBe('table.create returned 409: {"error":"payment_required"}')
		/* The plan limit and the conflict each looked for a row to adopt. */
		expect(run.sent.map((request) => request.method)).toEqual(["POST", "GET", "GET"])
		const plain = seeding(() => ({ body: { error: "bad" }, status: 400 }))
		await expect(createOne(plain.createOp, plain.seeding, scope)).rejects.toThrow("table.create returned 400")
	})

	it("reports a create it made but cannot identify, and returns no record", async () => {
		const unidentified: string[] = []
		const onUnidentified = (entity: string, operationId: string, exchange: Exchange): void => {
			unidentified.push(`${entity} ${operationId} ${exchange.status}`)
		}
		const run = seeding(() => ({ body: { ok: true }, status: 201 }), {}, { onUnidentified })
		expect(await createOne(run.createOp, run.seeding, scope)).toEqual({ adopted: false, record: {} })
		expect(unidentified).toEqual(["table table.create 201"])
		const silent = seeding(() => ({ body: { ok: true }, status: 201 }))
		expect(await createOne(silent.createOp, silent.seeding, scope)).toEqual({ adopted: false, record: {} })
	})

	it("names an unidentified create by its operation when no entity owns it", async () => {
		const model = modelOf(PAY)
		const unidentified: string[] = []
		const { client } = fakeClient(() => ({ body: { ok: true }, status: 200 }))
		const options = {
			principal: "alpha",
			onUnidentified: (entity: string) => unidentified.push(entity),
			roots: {},
			seed: 1,
		}
		expect(await createOne(op(model, "pay.start"), { client, model, options }, { created: [], values: {} })).toEqual({
			adopted: false,
			record: {},
		})
		expect(unidentified).toEqual(["pay.start"])
	})
})

/* A table the client names, by an integer id, among names kept unique: the client-ids shape. */
const CLIENT_ID = {
	requestBody: {
		content: {
			"application/json": {
				schema: {
					properties: { id: { maximum: 999, minimum: 1, type: "integer" }, name: { type: "string" } },
					required: ["id", "name"],
					type: "object",
				},
			},
		},
	},
	"x-unique": [["name"]],
}

/* Creates answer each status in turn, echoing the id they were sent; the list holds one row to adopt. */
const answering =
	(...statuses: number[]): Responder =>
	(method, _path, options) =>
		method === "POST"
			? { body: { id: (options.body as { id: unknown }).id }, status: statuses.shift() ?? 409 }
			: { body: [{ id: "t9" }], status: 200 }

describe("createOne, a client-chosen identity", () => {
	it("makes the ancestor under a fresh identity when the first is refused with 409, and keeps the refused one taken", async () => {
		const taken = new Set<string>()
		const run = seeding(answering(409, 201), CLIENT_ID, { taken: () => taken })
		const made = await createOne(run.createOp, run.seeding, scope)
		const ids = run.sent.map((request) => String((request.options.body as { id: unknown }).id))
		expect(run.sent.map((request) => request.method)).toEqual(["POST", "POST"])
		expect(new Set(ids).size).toBe(2)
		expect(made).toEqual({ adopted: false, record: { id: Number(ids[1]) } })
		expect(taken.has(ids[0] as string)).toBe(true)
	})

	it("records the gap after three refusals, adopting nothing and sending no fourth create", async () => {
		const run = seeding(answering(409, 409, 409, 201), CLIENT_ID)
		const refused = await createOne(run.createOp, run.seeding, scope).catch((error: unknown) => error)
		const ids = run.sent.map((request) => String((request.options.body as { id: unknown }).id))
		expect(run.sent.map((request) => request.method)).toEqual(["POST", "POST", "POST"])
		expect(refused).toBeInstanceOf(SeedError)
		expect((refused as SeedError).message).toBe(
			`table.create: every client-chosen "id" sent was refused with 409 (${ids.join(", ")}); no fourth create was sent`,
		)
	})
})
