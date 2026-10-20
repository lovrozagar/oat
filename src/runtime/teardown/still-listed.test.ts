import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import type { RequestOptions } from "../../client/types.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { FencedError } from "../fence.ts"
import { NetworkError } from "../../errors/network.ts"
import { disposable, notesClient, notesModel, owner, type Paging, type Store, store } from "./__fixtures__/notes.ts"
import { type ListGroup, stillListed } from "./still-listed.ts"

const ids = (count: number) => Array.from({ length: count }, (_, at) => `n${at + 1}`)

/** Which of `wanted` the notes list still holds, as `alpha` reads it, paging as `paging`. */
async function relist(paging: Paging, held: Store, wanted: string[]) {
	const model = notesModel(paging)
	const listOp = model.byOperationId.get("notes.list") as OperationModel
	const group: ListGroup = {
		identity: "id",
		items: wanted.map((id) => disposable("note", id)),
		listOp,
		owner: owner("alpha"),
		path: listOp.path,
	}
	const { client, sent } = notesClient(held)
	return { listed: await stillListed(model, client, group), sent }
}

const network = new NetworkError({
	attempts: 1,
	cause: new Error("x"),
	kind: "refused",
	message: "GET refused",
	method: "GET",
	url: "u",
})
const fenced = new FencedError({ method: "GET", phase: "teardown", reason: "no", url: "u" })

describe("stillListed: paging", () => {
	it("reads one page of a list that does not page", async () => {
		const { listed, sent } = await relist("none", store({ alpha: ["n1", "n2"] }), ["n2", "n3"])
		expect([...(listed ?? [])]).toEqual(["n2"])
		expect(sent).toHaveLength(1)
	})

	it("walks page numbers, offsets and cursors until every record is seen", async () => {
		for (const paging of ["page", "offset", "cursor"] as const) {
			const { listed, sent } = await relist(paging, store({ alpha: ids(5) }, { pageSize: 2 }), ["n5"])
			expect([...(listed ?? [])]).toEqual(["n5"])
			expect(sent.map((request) => request.options.query)).toHaveLength(3)
		}
		const { sent } = await relist("offset", store({ alpha: ids(5) }, { pageSize: 2 }), ["n9"])
		expect(sent.map((request) => (request.options.query as Record<string, unknown>).offset)).toEqual([undefined, 2, 4])
	})

	it("stops at an empty page, a repeated page, a short page, or a list with no next cursor", async () => {
		const repeated = store(
			{ alpha: ids(2) },
			{ answers: { "GET /notes": { body: { items: [{ id: "n1" }] }, status: 200 } } },
		)
		expect((await relist("page", repeated, ["n9"])).sent).toHaveLength(2)
		expect((await relist("page", store({ alpha: ids(3) }, { pageSize: 2 }), ["n9"])).sent).toHaveLength(2)
		expect((await relist("cursor", store({ alpha: ids(2) }, { pageSize: 2 }), ["n9"])).sent).toHaveLength(1)
		expect((await relist("page", store({ alpha: [] }), ["n1"])).sent).toHaveLength(1)
	})

	it("skips rows with no id", async () => {
		const held = store(
			{},
			{ answers: { "GET /notes": { body: { items: [{ name: "x" }, { id: "n1" }] }, status: 200 } } },
		)
		expect([...((await relist("none", held, ["n1"])).listed ?? [])]).toEqual(["n1"])
	})

	it("reads at most fifty pages", async () => {
		const { sent } = await relist("page", store({ alpha: ids(60) }, { pageSize: 1 }), ["n99"])
		expect(sent).toHaveLength(50)
	})
})

describe("stillListed: shapes", () => {
	it("reads a list whose rows are the body itself", async () => {
		const answers = { "GET /notes/n1/comments": { body: [{ id: "c1" }], status: 200 } }
		const model = notesModel()
		const listOp = model.byOperationId.get("comments.list") as OperationModel
		const group: ListGroup = {
			identity: "id",
			items: [disposable("comment", "c1")],
			listOp,
			owner: owner("alpha"),
			path: "/notes/n1/comments",
		}
		const { client } = notesClient(store({}, { answers }))
		expect([...((await stillListed(model, client, group)) ?? [])]).toEqual(["c1"])
	})
})

/** A list whose page `failing` answers with `answer`, every other page a full one. */
const failingAt = (failing: number, answer: () => never | { status: number }): Store => {
	const held = store({ alpha: ids(4) }, { pageSize: 2 })
	const full = held
	held.answers["GET /notes"] = (options: Omit<RequestOptions, "as">) => {
		const page = Number((options.query as Record<string, unknown>).page ?? 1)
		if (page === failing) return answer()
		return {
			body: { items: (full.notes.get("alpha") ?? []).slice((page - 1) * 2, page * 2).map((id) => ({ id })) },
			status: 200,
		}
	}
	return held
}

describe("stillListed: refusals", () => {
	it("claims nothing when the first page cannot be read", async () => {
		expect(
			(
				await relist(
					"page",
					failingAt(1, () => ({ status: 403 })),
					["n1"],
				)
			).listed,
		).toBeNull()
		expect(
			(
				await relist(
					"page",
					failingAt(1, () => {
						throw fenced
					}),
					["n1"],
				)
			).listed,
		).toBeNull()
	})

	it("keeps what earlier pages showed when a later one cannot be read", async () => {
		expect([
			...((
				await relist(
					"page",
					failingAt(2, () => ({ status: 500 })),
					["n1", "n4"],
				)
			).listed ?? []),
		]).toEqual(["n1"])
		expect([
			...((
				await relist(
					"page",
					failingAt(2, () => {
						throw network
					}),
					["n1", "n4"],
				)
			).listed ?? []),
		]).toEqual(["n1"])
	})
})

describe("stillListed: a list it cannot ask", () => {
	it("claims nothing when the owner's credential is BLOCKED: the list could not be asked", async () => {
		const blocked = failingAt(1, () => {
			throw new UnsatisfiedSecurity("blocked", "signed in again, and the new credential is refused")
		})
		expect((await relist("page", blocked, ["n1"])).listed).toBeNull()
	})

	it("throws what is neither fenced nor the network", async () => {
		await expect(
			relist(
				"page",
				failingAt(1, () => {
					throw new TypeError("bug")
				}),
				["n1"],
			),
		).rejects.toThrow("bug")
	})
})
