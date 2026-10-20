import { describe, expect, it } from "vitest"
import { UnsatisfiedSecurity } from "../../client/credential-source.ts"
import { NetworkError } from "../../errors/network.ts"
import { actorOf, disposable, notesModel, owner, store, unwindOf } from "./__fixtures__/notes.ts"
import { leftover, removeOne } from "./remove.ts"

const model = notesModel()

describe("removeOne", () => {
	it("removes a record its creator deletes, and counts it", async () => {
		const note = disposable("note", "n1")
		const done: Array<[number, number]> = []
		const state = unwindOf(store({ alpha: ["n1"] }), [note], { model, onItem: (at, total) => done.push([at, total]) })
		await removeOne(state, note)
		expect(state.sent.map((request) => `${request.method} ${request.path}`)).toEqual(["DELETE /notes/n1"])
		expect(state.report.removed).toBe(1)
		expect(state.records.get(note)?.removed).toBe(true)
		expect(state.paths.get(note)).toBe("/notes/n1")
		expect(done).toEqual([[1, 1]])
	})

	it("takes the creator's 404 as gone, but nobody else's", async () => {
		const note = disposable("note", "n1")
		const state = unwindOf(store(), [note], { model })
		await removeOne(state, note)
		expect(state.report.removed).toBe(1)
		const moved = unwindOf(store(), [note], {
			model,
			ledger: { movedAway: () => "moved to t2", seenByCreator: () => true, sighted: () => undefined },
		})
		await removeOne(moved, note)
		expect(moved.report.failed).toEqual([leftover(note, "moved to t2; DELETE /notes/n1 returned alpha: 404")])
	})

	it("retries a denial with a stronger credential, and stops at anything else", async () => {
		const note = disposable("note", "n1", { by: "beta" })
		const held = store({ alpha: ["n1"] }, { answers: {} })
		const state = unwindOf(held, [note], { model, fallbacks: () => [owner("member"), owner("root")] })
		held.answers["DELETE /notes/n1"] = (options) => {
			const who = actorOf(options)
			return who === "root" ? { status: 204 } : { status: who === "beta" ? 403 : 401 }
		}
		await removeOne(state, note)
		expect(state.sent.map((request) => [request.method, request.options.as])).toEqual([
			["DELETE", { principal: "beta" }],
			["DELETE", { principal: "member" }],
			["DELETE", { principal: "root" }],
		])
		expect(state.report.removed).toBe(1)
		const failing = unwindOf(store({}, { answers: { "DELETE /notes/n1": { status: 500 } } }), [note], {
			model,
			fallbacks: () => [owner("root")],
		})
		await removeOne(failing, note)
		expect(failing.report.failed).toEqual([leftover(note, "DELETE /notes/n1 returned beta: 500")])
	})
})

describe("removeOne: other ways a record goes or stays", () => {
	it("counts a record removed when a delete earlier in the run took it", async () => {
		const note = disposable("note", "n1")
		const state = unwindOf(store({}, { answers: { "DELETE /notes/n1": { status: 403 } } }), [note], {
			model,
			deletedEarlier: (path) => path === "/notes/n1",
		})
		await removeOne(state, note)
		expect(state.report.removed).toBe(1)
	})

	it("reports an entity with no delete, a path it cannot fill, and a delete it cannot send", async () => {
		const tag = disposable("tag", "t1")
		const comment = disposable("comment", "c1")
		const note = disposable("note", "n1")
		const state = unwindOf(
			store(
				{},
				{
					answers: {
						"DELETE /notes/n1": () => {
							throw new NetworkError({
								attempts: 1,
								cause: new Error("x"),
								kind: "refused",
								message: "DELETE refused",
								method: "DELETE",
								url: "u",
							})
						},
					},
				},
			),
			[tag, comment, note],
			{ model },
		)
		await removeOne(state, tag)
		await removeOne(state, comment)
		await removeOne(state, note)
		expect([...state.unsupported]).toEqual(["tag"])
		expect(state.report.failed.map((entry) => entry.reason)).toEqual([
			expect.stringMatching(/note_id/),
			"DELETE refused",
		])
		expect(state.done).toBe(3)
	})
})

describe("removeOne: other routes and throws", () => {
	it("removes through a cleanup route that names no id, with the method the route names", async () => {
		const widgets = notesModel("none", {
			"/admin/purge": { post: { operationId: "widgets.purge", responses: { "204": { description: "gone" } } } },
			"/widgets": {
				post: {
					operationId: "widgets.create",
					responses: { "200": { description: "ok" } },
					"x-cleanup": "POST /admin/purge",
					"x-entity": { action: "create", identity: "id", name: "widget" },
				},
			},
		})
		const widget = disposable("widget", "w1")
		const state = unwindOf(store({}, { answers: { "POST /admin/purge": { status: 204 } } }), [widget], {
			model: widgets,
		})
		await removeOne(state, widget)
		expect(state.paths.get(widget)).toBe("/admin/purge")
		expect(state.client.transcript.map((exchange) => exchange.method)).toEqual(["POST"])
		expect(state.report.removed).toBe(1)
	})

	it("reports what a delete threw that is not an error", async () => {
		const note = disposable("note", "n1")
		const throwing = unwindOf(
			store(
				{},
				{
					answers: {
						"DELETE /notes/n1": () => {
							throw "socket hang up"
						},
					},
				},
			),
			[note],
			{ model },
		)
		await removeOne(throwing, note)
		expect(throwing.report.failed).toEqual([leftover(note, "socket hang up")])
	})
})

describe("removeOne: a deleter whose credential is BLOCKED", () => {
	it("tries the next deleter, and names why when none can remove it", async () => {
		const note = disposable("note", "n1", { by: "beta" })
		const held = store({ alpha: ["n1"] }, { answers: {} })
		held.answers["DELETE /notes/n1"] = (options) => {
			const who = actorOf(options)
			if (who !== "root") throw new UnsatisfiedSecurity("blocked", `refresh for ${who}/jwt: token revoked`)
			return { status: 204 }
		}
		const state = unwindOf(held, [note], { model, fallbacks: () => [owner("member"), owner("root")] })
		await removeOne(state, note)
		expect(state.sent.map((request) => request.options.as)).toEqual([
			{ principal: "beta" },
			{ principal: "member" },
			{ principal: "root" },
		])
		expect(state.report.removed).toBe(1)
		const stuck = unwindOf(held, [note], { model, fallbacks: () => [owner("member")] })
		await removeOne(stuck, note)
		expect(stuck.report.failed).toEqual([
			leftover(
				note,
				"DELETE /notes/n1 returned beta: not sent (refresh for beta/jwt: token revoked), " +
					"member: not sent (refresh for member/jwt: token revoked)",
			),
		])
	})
})
