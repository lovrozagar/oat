import { describe, expect, it } from "vitest"
import { exchange, modelOf, op } from "../checks/__fixtures__/harness.ts"
import type { Exchange } from "../exchange.ts"
import { type OperationModel } from "../../spec/graph/types.ts"
import { tables } from "./__fixtures__/documents.ts"
import {
	bodyIdentity,
	type ClientIdentity,
	createWithClientId,
	identitiesRefused,
	reserveIdentity,
	takenFor,
} from "./client-identity.ts"

/* A create whose client-chosen identity is drawn and, on a 409, drawn again. */

const SCHEMA = { properties: { id: { maximum: 999, minimum: 1, type: "integer" }, name: { type: "string" } } }

const at = (taken: Set<string>, identity: string | null = "id"): ClientIdentity => ({
	identity,
	schema: SCHEMA,
	taken,
	token: "t",
})

/* Answers each create with the next status, and keeps every body it was sent. */
function server(statuses: number[]) {
	const sent: Array<Record<string, unknown>> = []
	const send = async (body: Record<string, unknown>): Promise<Exchange> => {
		sent.push(body)
		return exchange("POST", "/tables", { body: { id: body["id"] }, status: statuses.shift() ?? 409 })
	}
	return { send, sent }
}

describe("createWithClientId", () => {
	it("sends a refused identity again as one no record holds, and the refused one joins the taken set", async () => {
		const taken = new Set(["5"])
		const { send, sent } = server([409, 201])
		const made = await createWithClientId({ id: 7, name: "a" }, send, at(taken))
		expect(made.exchange.status).toBe(201)
		expect(made.exhausted).toBeUndefined()
		expect(sent.map((body) => body["name"])).toEqual(["a", "a"])
		expect(sent[0]?.["id"]).toBe(7)
		expect(["5", "7"]).not.toContain(String(sent[1]?.["id"]))
		expect([...taken].toSorted()).toEqual(["5", "7", String(sent[1]?.["id"])].toSorted())
		expect(made.sent).toBe(sent[1])
	})

	it("stops after three refusals, says why, and sends no fourth create", async () => {
		const taken = new Set<string>()
		const { send, sent } = server([409, 409, 409, 201])
		const made = await createWithClientId({ id: 7, name: "a" }, send, at(taken))
		expect(sent).toHaveLength(3)
		expect(made.exchange.status).toBe(409)
		const ids = sent.map((body) => String(body["id"]))
		expect(new Set(ids).size).toBe(3)
		expect([...taken].toSorted()).toEqual(ids.toSorted())
		expect(made.exhausted).toBe(
			`every client-chosen "id" sent was refused with 409 (${ids.join(", ")}); no fourth create was sent`,
		)
	})

	it("stops, saying why, when no identity is left to draw after a refusal", async () => {
		const only = { ...at(new Set()), schema: { properties: { id: { enum: [1], type: "integer" } } } }
		const { send, sent } = server([409, 201])
		const made = await createWithClientId({ id: 1 }, send, only)
		expect(sent).toHaveLength(1)
		expect(made.exhausted).toBe(
			'every client-chosen "id" sent was refused with 409 (1); no "id" is left that names no existing record',
		)
	})

	it("takes a 409 as the answer when the body names no identity of its own", async () => {
		for (const [body, identity] of [
			[{ name: "a" }, "id"],
			[{ id: 7, name: "a" }, null],
		] as const) {
			const { send, sent } = server([409])
			const made = await createWithClientId({ ...body }, send, at(new Set(), identity))
			expect([sent.length, made.exchange.status, made.exhausted]).toEqual([1, 409, undefined])
		}
	})
})

/* A create filed under `entity`. */
const create = (entity: string | null): OperationModel => ({ entity }) as OperationModel

describe("takenFor", () => {
	it("shares the run's identities for the create's entity, and keeps its own where there is none to share", () => {
		const table = new Set(["7"])
		const options = { taken: (entity: string) => (entity === "table" ? table : new Set<string>()) }
		expect(takenFor(options, create("table"))).toBe(table)
		expect(takenFor(options, create(null))).toEqual(new Set())
		expect(takenFor({}, create("table"))).toEqual(new Set())
	})
})

describe("bodyIdentity", () => {
	it("is the entity's identity where the create body has it, and none where it does not", () => {
		const model = modelOf(tables())
		const tableCreate = op(model, "table.create")
		expect(bodyIdentity(model, tableCreate, SCHEMA)).toBe("id")
		expect(bodyIdentity(model, tableCreate, { properties: { name: { type: "string" } } })).toBeNull()
		expect(bodyIdentity(model, tableCreate, {})).toBeNull()
		expect(bodyIdentity(model, { ...tableCreate, entity: null }, SCHEMA)).toBeNull()
	})
})

describe("identitiesRefused", () => {
	it("fails the seed with the create, its answer and the reason", () => {
		const refused = exchange("POST", "/tables", { status: 409 })
		const error = identitiesRefused("table.create", refused, "why")
		expect([error.message, error.operationId, error.status, error.exchange]).toEqual([
			"table.create: why",
			"table.create",
			409,
			refused,
		])
	})
})

describe("reserveIdentity", () => {
	it("draws an identity no record holds, reserves it, and leaves a free one as it is", () => {
		const taken = new Set(["7"])
		const drawn = reserveIdentity({ id: 7, name: "a" }, at(taken))
		expect(drawn["id"]).not.toBe(7)
		expect(taken.has(String(drawn["id"]))).toBe(true)
		expect(reserveIdentity({ id: 8, name: "a" }, at(taken))).toEqual({ id: 8, name: "a" })
		expect(taken.has("8")).toBe(true)
		expect(reserveIdentity({ name: "a" }, at(taken))).toEqual({ name: "a" })
	})

	it("refuses when every identity the schema allows is taken", () => {
		const only = { ...at(new Set(["1"])), schema: { properties: { id: { enum: [1], type: "integer" } } } }
		expect(() => reserveIdentity({ id: 1 }, only)).toThrow('no "id" is left that names no existing record')
	})
})
