import { describe, expect, it } from "vitest"
import type { OperationModel } from "../../spec/graph/types.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { type Answer, exchange, fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import { notes } from "./__fixtures__/documents.ts"
import { createdRecord } from "./created-record.ts"

const scope = { projectId: "p1" }

function created(input: {
	answer: Answer
	sent: unknown
	read?: Answer
	create?: Record<string, unknown>
	operation?: string
	readable?: (op: OperationModel) => boolean
	wants?: "id"
}) {
	const model = modelOf(notes({ create: input.create ?? {} }))
	const fake = fakeClient(() => input.read ?? { status: 404 })
	const result = createdRecord({
		client: fake.client,
		createOp: op(model, input.operation ?? "note.create"),
		exchange: exchange("POST", "/projects/p1/notes", input.answer),
		model,
		principal: "alpha",
		scope,
		sent: input.sent,
		...(input.readable === undefined ? {} : { readable: input.readable }),
		...(input.wants === undefined ? {} : { wants: input.wants }),
	})
	return { result, sent: fake.sent }
}

describe("createdRecord", () => {
	it("trusts the id the answer names as its own identity", async () => {
		const { result, sent } = created({ answer: { body: { id: "n1", name: "a" }, status: 201 }, sent: { name: "a" } })
		expect(await result).toEqual({ acknowledged: false, record: { id: "n1", name: "a" } })
		expect(sent).toEqual([])
	})

	it("trusts a declared createdIdFrom, and takes the record from a declared recordPath", async () => {
		const create = { "x-entity": { action: "create", createdIdFrom: "$.meta.ref", name: "note", recordPath: "$.data" } }
		const { result } = created({
			answer: { body: { data: { name: "a" }, meta: { ref: 9 } }, status: 201 },
			create,
			sent: { name: "a" },
		})
		expect(await result).toEqual({ acknowledged: false, record: { id: 9, name: "a" } })
		const empty = created({ answer: { body: { meta: { ref: 9 } }, status: 201 }, create, sent: { name: "a" } })
		expect(await empty.result).toEqual({ acknowledged: false, record: { id: 9, name: "a" }, unverified: true })
	})

	it("confirms a candidate id by reading under it, as JSON text the probe sent", async () => {
		const read = { body: { id: "n2", name: "a" }, status: 200 }
		const answer = { body: { data: { id: "n2", name: "a" }, ok: true }, status: 201 }
		const { result, sent } = created({ answer, read, sent: JSON.stringify({ name: "a" }) })
		expect(await result).toEqual({ acknowledged: false, record: { id: "n2", name: "a" } })
		expect(sent.map((request) => request.path)).toEqual(["/projects/p1/notes/n2"])
	})

	it("confirms an acknowledgement under the id the client chose", async () => {
		const read = { body: { id: "c1", name: "a" }, status: 200 }
		const { result } = created({ answer: { status: 200 }, read, sent: { id: "c1", name: "a" } })
		expect(await result).toEqual({ acknowledged: true, record: { id: "c1", name: "a" } })
	})
})

describe("createdRecord, from an answer that is not the record", () => {
	const read = { body: { id: "n1", name: "a", size: 2 }, status: 200 }

	it("reads an acknowledgement's record back by the id it names, and seeds what the read returns", async () => {
		const { result, sent } = created({
			answer: { body: { id: "n1", message: "created" }, status: 201 },
			read,
			sent: { name: "a" },
		})
		expect(await result).toEqual({ acknowledged: false, record: { id: "n1", name: "a", size: 2 } })
		expect(sent.map((request) => request.path)).toEqual(["/projects/p1/notes/n1"])
	})

	it("reads back an echo that leaves out a field the create sent", async () => {
		const { result } = created({
			answer: { body: { id: "n1", name: "a" }, status: 201 },
			read,
			sent: { name: "a", size: 2 },
		})
		expect(await result).toEqual({ acknowledged: false, record: read.body })
	})

	it("reads an empty 201 back by the id its Location names", async () => {
		const answer = { headers: { location: "https://api.test/projects/p1/notes/n1" }, status: 201 }
		const { result, sent } = created({ answer, read, sent: { name: "a" } })
		expect(await result).toEqual({ acknowledged: false, record: read.body })
		expect(sent.map((request) => request.path)).toEqual(["/projects/p1/notes/n1"])
	})

	it("reads nothing back when only the id is wanted", async () => {
		const answer = { headers: { Location: "/projects/p1/notes/n1/" }, status: 201 }
		const { result, sent } = created({ answer, read, sent: { name: "a" }, wants: "id" })
		expect(await result).toEqual({ acknowledged: false, record: { id: "n1" } })
		expect(sent).toEqual([])
	})
})

describe("createdRecord, unconfirmed", () => {
	it("is null when nothing confirms the record, and for text that is not JSON", async () => {
		expect(
			await created({ answer: { body: { ok: true }, status: 200 }, sent: { id: "c1", name: "a" } }).result,
		).toBeNull()
		expect(await created({ answer: { status: 200 }, sent: "name=a" }).result).toBeNull()
		const unreadable = created({
			answer: { status: 200 },
			read: { body: { id: "c1", name: "a" }, status: 200 },
			readable: () => false,
			sent: { id: "c1", name: "a" },
		})
		expect(await unreadable.result).toBeNull()
	})

	it("cannot confirm a create no entity owns, but trusts the id it names", async () => {
		const model = modelOf({
			info: { title: "pay", version: "1" },
			openapi: "3.1.0",
			paths: { "/v1/pay": { post: { operationId: "pay.start", responses: { "200": { description: "ok" } } } } },
		} as OpenApiDocument)
		const createOp = op(model, "pay.start")
		expect(createOp.entity).toBeNull()
		const { client } = fakeClient(() => ({ status: 200 }))
		const made = (body: unknown) =>
			createdRecord({
				client,
				createOp,
				exchange: exchange("POST", "/v1/pay", { body, status: 200 }),
				principal: "alpha",
				model,
				scope,
				sent: { amount: 1 },
			})
		expect(await made({ ok: true })).toBeNull()
		expect(await made({ amount: 1, id: 4 })).toEqual({ acknowledged: false, record: { amount: 1, id: 4 } })
		/* Nothing to read it back by: what was sent, under the id it names. */
		expect(await made({ id: 4 })).toEqual({ acknowledged: false, record: { amount: 1, id: 4 }, unverified: true })
		expect(await made(null)).toBeNull()
	})
})
