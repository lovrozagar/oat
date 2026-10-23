import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import { type Answer, fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import { FencedError } from "../fence.ts"
import { notes } from "./__fixtures__/documents.ts"
import { answersRecord, expectedFields, readBackCreated } from "./read-back.ts"

const scope = { projectId: "p1" }

describe("answersRecord", () => {
	const expected = { required: ["id", "name"], submitted: ["name", "size"] }

	it("is the record when it names every required field and every field the create sent", () => {
		expect(answersRecord({ id: "n1", name: "a", size: 1 }, expected)).toBe(true)
		/* Names, not values: a field the server normalized is still the record's. */
		expect(answersRecord({ id: "n1", name: "A", size: null }, expected)).toBe(true)
	})

	it("is not the record when it lacks a required field or one the create sent", () => {
		expect(answersRecord({ id: "n1", size: 1 }, expected)).toBe(false)
		expect(answersRecord({ id: "n1", name: "a" }, expected)).toBe(false)
		/* An acknowledgement's own fields do not make it the record. */
		expect(answersRecord({ id: "n1", message: "created" }, expected)).toBe(false)
	})
})

describe("expectedFields", () => {
	it("is the item schema's required fields and every field sent, never a writeOnly one or one left undefined", () => {
		const body = {
			properties: { name: { type: "string" }, secret: { type: "string", writeOnly: true }, size: { type: "integer" } },
			type: "object",
		}
		const model = modelOf(notes({ body }))
		const createOp = op(model, "note.create")
		expect(expectedFields(model, createOp, { name: "a", secret: "s", size: undefined, tags: [] })).toEqual({
			required: ["id", "name"],
			submitted: ["name", "tags"],
		})
		expect(expectedFields(model, createOp, "name=a")).toEqual({ required: ["id", "name"], submitted: [] })
	})

	it("requires nothing of a create no entity owns or whose entity has no item schema", () => {
		const model = modelOf(notes({ body: null, list: false, read: false }))
		expect(expectedFields(model, op(model, "note.create"), { name: "a" })).toEqual({
			required: [],
			submitted: ["name"],
		})
	})
})

function readBack(input: {
	read?: { status: number; body?: unknown } | (() => Answer)
	readable?: boolean
	document?: object
	scope?: Record<string, string>
}) {
	const model = modelOf(notes(input.document ?? {}))
	const { read } = input
	const fake = fakeClient(() => (typeof read === "function" ? read() : (read ?? { status: 404 })))
	const result = readBackCreated({
		client: fake.client,
		createOp: op(model, "note.create"),
		id: { id: "n1" as never, trusted: true, value: "n1" },
		model,
		principal: "alpha",
		scope: input.scope ?? scope,
		sent: { name: "a" },
		...(input.readable === undefined ? {} : { readable: () => input.readable as boolean }),
	})
	return { result, sent: fake.sent }
}

/** The body sent under the id, unverified for `cause`. */
const unverified = (cause: string) => ({ acknowledged: false, record: { id: "n1", name: "a" }, unverified: cause })

describe("readBackCreated", () => {
	it("is the record the item read answers under the id, as the creator", async () => {
		const { result, sent } = readBack({ read: { body: { id: "n1", name: "a", size: 3 }, status: 200 } })
		expect(await result).toEqual({ acknowledged: false, record: { id: "n1", name: "a", size: 3 } })
		expect(sent.map((request) => [request.path, request.options.as, request.options.operationId])).toEqual([
			["/projects/p1/notes/n1", { principal: "alpha" }, "note.get"],
		])
	})

	it("gives a read that leaves out the identity the id it was read under", async () => {
		const { result } = readBack({ read: { body: { name: "a" }, status: 200 } })
		expect(await result).toEqual({ acknowledged: false, record: { id: "n1", name: "a" } })
	})

	it("is the body sent with the id, unverified, when the read refuses, answers another record or none", async () => {
		expect(await readBack({ read: { status: 404 } }).result).toEqual(unverified("read back answered 404"))
		expect(await readBack({ read: { body: { id: "n2", name: "a" }, status: 200 } }).result).toEqual(
			unverified("read back answered 200 with another record"),
		)
		expect(await readBack({ read: { body: [], status: 200 } }).result).toEqual(
			unverified("read back answered 200 without the record"),
		)
	})

	it("is unverified, reading nothing, with no item read, one oat may not call, or one it cannot address", async () => {
		const none = readBack({ document: { read: false } })
		expect(await none.result).toMatchObject({ unverified: "no item read" })
		expect(none.sent).toEqual([])
		const barred = readBack({ read: { body: { id: "n1" }, status: 200 }, readable: false })
		expect(await barred.result).toMatchObject({ unverified: "no item read" })
		expect(barred.sent).toEqual([])
		const unaddressable = readBack({ read: { body: { id: "n1" }, status: 200 }, scope: {} })
		expect(await unaddressable.result).toMatchObject({
			unverified: "the item read could not be addressed: no value for path parameter {projectId}",
		})
		expect(unaddressable.sent).toEqual([])
	})
})

describe("readBackCreated, a body that is not a record", () => {
	it("keeps only the id when what was sent is not a record", async () => {
		const model = modelOf(notes({ read: false }))
		const made = await readBackCreated({
			client: fakeClient(() => undefined).client,
			createOp: op(model, "note.create"),
			id: { id: "7" as never, trusted: true, value: 7 },
			model,
			principal: "alpha",
			scope,
			sent: "name=a",
		})
		expect(made).toEqual({ acknowledged: false, record: { id: 7 }, unverified: "no item read" })
	})
})

describe("readBackCreated, a read the creator cannot send", () => {
	it("is unverified when the creator's credential cannot meet the read's security", async () => {
		const unmet = readBack({
			read: () => {
				throw new UnsatisfiedSecurity("unsatisfied", "no credential for jwt")
			},
		})
		expect(await unmet.result).toEqual({
			acknowledged: false,
			record: { id: "n1", name: "a" },
			unverified: "read back could not be sent: no credential for jwt",
		})
	})

	it("is unverified when the fence refuses the read", async () => {
		const fenced = readBack({
			read: () => {
				throw new FencedError({ method: "GET", phase: "seed", reason: "no reads", url: "http://api.test/n1" })
			},
		})
		expect(await fenced.result).toMatchObject({ unverified: expect.stringMatching(/^read back could not be sent: /) })
	})

	it("lets any other failure, a network error say, end the seed", async () => {
		const offline = readBack({
			read: () => {
				throw new TypeError("fetch failed")
			},
		})
		await expect(offline.result).rejects.toThrow("fetch failed")
	})
})
