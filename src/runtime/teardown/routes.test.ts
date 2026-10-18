import { describe, expect, it } from "vitest"
import { exchange } from "../checks/__fixtures__/harness.ts"
import { disposable, notesModel } from "./__fixtures__/notes.ts"
import { deletedEarlierIn, deleteOperationFor, keyOf, readPathOf, recordKey } from "./routes.ts"

describe("recordKey / keyOf", () => {
	it("keys a record by entity, id and principal", () => {
		expect(recordKey("note", "n1", "alpha")).toBe("note\u0000n1\u0000alpha")
		expect(keyOf(disposable("note", "n1"))).toBe(recordKey("note", "n1", "alpha"))
	})
})

describe("deletedEarlierIn", () => {
	const transcript = [
		exchange("DELETE", "/api/tables/1", { status: 204 }),
		exchange("DELETE", "/api/rows/%E0%A4%A", { status: 200 }),
		exchange("DELETE", "/api/kept/1", { status: 404 }),
		exchange("GET", "/api/read/1", { status: 200 }),
	]
	const deletedEarlier = deletedEarlierIn(transcript)

	it("matches the path or an ancestor removed earlier, by segments", () => {
		expect(deletedEarlier("/tables/1")).toBe(true)
		expect(deletedEarlier("/tables/1/columns/c1?force=true")).toBe(true)
		expect(deletedEarlier("/tables/11")).toBe(false)
		expect(deletedEarlier("/rows/%E0%A4%A")).toBe(true)
	})

	it("ignores refused deletes and reads", () => {
		expect(deletedEarlier("/kept/1")).toBe(false)
		expect(deletedEarlier("/read/1")).toBe(false)
		expect(deletedEarlierIn([])("/tables/1")).toBe(false)
	})
})

describe("readPathOf", () => {
	const model = notesModel("none", {
		"/me": {
			get: {
				operationId: "me.get",
				responses: { "200": { description: "ok" } },
				"x-entity": { action: "read", identity: "id", name: "profile" },
			},
		},
	})

	it("fills the entity's read with the record's id", () => {
		expect(readPathOf(model, disposable("comment", "c1", { note_id: "n1" }))).toMatchObject({
			op: { operationId: "comments.get" },
			path: "/notes/n1/comments/c1",
		})
	})

	it("is null without a read, a read that names no id, or a scope that cannot fill it", () => {
		expect(readPathOf(model, disposable("tag", "t1"))).toBeNull()
		expect(readPathOf(model, disposable("ghost", "g1"))).toBeNull()
		expect(readPathOf(model, disposable("profile", "p1"))).toBeNull()
		expect(readPathOf(model, disposable("comment", "c1"))).toBeNull()
	})
})

/** A widget entity whose removal is the `x-cleanup` route `route`. */
const cleanup = (route: string) => ({
	"/widgets": {
		get: {
			operationId: "widgets.list",
			responses: { "200": { description: "ok" } },
			"x-entity": { action: "list", identity: "id", name: "widget" },
		},
		post: {
			operationId: "widgets.create",
			responses: { "200": { description: "ok" } },
			"x-cleanup": route,
			"x-entity": { action: "create", identity: "id", name: "widget" },
		},
	},
})

describe("deleteOperationFor", () => {
	it("is the entity's delete, else an x-cleanup route", () => {
		const model = notesModel()
		expect(deleteOperationFor("note", model)?.operationId).toBe("notes.delete")
		expect(deleteOperationFor("label", model)?.operationId).toBe("labels.purge")
		expect(deleteOperationFor("tag", model)).toBeNull()
		expect(deleteOperationFor("ghost", model)).toBeNull()
	})

	it("passes over a cleanup it cannot read or find", () => {
		expect(deleteOperationFor("widget", notesModel("none", cleanup("nonsense")))).toBeNull()
		expect(deleteOperationFor("widget", notesModel("none", cleanup("DELETE /nowhere/{id}")))).toBeNull()
		const purge = {
			"/admin/purge": { post: { operationId: "widgets.purge", responses: { "204": { description: "gone" } } } },
		}
		expect(
			deleteOperationFor("widget", notesModel("none", { ...cleanup("POST /admin/purge"), ...purge }))?.operationId,
		).toBe("widgets.purge")
	})
})
