import { describe, expect, it } from "vitest"
import { list, member, ok } from "../__fixtures__/documents.ts"
import { details, operationsOf } from "./__fixtures__/operations.ts"
import { demoteNonEntities } from "./demote.ts"

const demoted = (paths: Record<string, unknown>) => {
	const { gaps, operations } = operationsOf(paths)
	const views = demoteNonEntities(operations, gaps)
	return {
		entities: Object.fromEntries(operations.map((op) => [op.operationId, [op.entity, op.action]])),
		gaps,
		views: views.map((op) => op.operationId),
	}
}

describe("demoteNonEntities", () => {
	it("keeps a noun with an item route, and makes a verb under it an action on it", () => {
		const { entities, views } = demoted({
			"/tables": { get: { operationId: "tables.list", responses: ok(list(member)) } },
			"/tables/{id}": { get: { operationId: "tables.get", responses: ok(member) } },
			"/tables/{id}/duplicate": { post: { operationId: "tables.duplicate", responses: ok(member) } },
			"/tables/{id}/findByName": { get: { operationId: "tables.find", responses: ok(list(member)) } },
		})
		expect(entities).toEqual({
			"tables.duplicate": ["table", "action"],
			"tables.find": ["table", "action"],
			"tables.get": ["table", "read"],
			"tables.list": ["table", "list"],
		})
		expect(views).toEqual([])
	})

	it("keeps a collection without an item route as a view, with the create posted to it", () => {
		const { entities, gaps, views } = demoted({
			"/notes": {
				get: { operationId: "notes.list", responses: ok(list(member)) },
				post: { operationId: "notes.create", responses: ok(member) },
			},
			"/reports": { post: { operationId: "reports.create", responses: ok(member) } },
		})
		expect(views).toEqual(["notes.list"])
		expect(entities["notes.create"]).toEqual(["note", "create"])
		expect(entities["reports.create"]).toEqual([null, null])
		expect(details(gaps, "x-entity")).toEqual([
			'"/reports" names no collection with an item route and sits under none, so it belongs to no entity and gets no lifecycle coverage. Name its entity with x-entity',
		])
	})

	it("reads a verb-like last segment as an operation, not a collection", () => {
		const { entities, views } = demoted({
			"/pet/{id}": { get: { operationId: "pet.get", responses: ok(member) } },
			"/pet/findByStatus": { get: { operationId: "pet.find", responses: ok(list(member)) } },
		})
		expect(entities["pet.find"]).toEqual(["pet", "action"])
		expect(views).toEqual([])
	})

	it("leaves tagged operations and the root path alone", () => {
		const { entities, views } = demoted({
			"/": { get: { operationId: "root", responses: ok(list(member)) } },
			"/feed": {
				get: { operationId: "feed", responses: ok(list(member)), "x-entity": { action: "list", name: "post" } },
			},
		})
		expect(entities).toEqual({ feed: ["post", "list"], root: [null, null] })
		expect(views).toEqual([])
	})
})
