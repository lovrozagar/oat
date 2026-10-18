import { describe, expect, it } from "vitest"
import { GapCollector } from "../extensions/gaps.ts"
import { details, operation } from "./__fixtures__/operations.ts"
import { entityNamed } from "./entities.ts"
import { fallBackToSiblings, invertInvalidate, markTrackable } from "./surface.ts"
import type { EntityModel, OperationModel } from "./types.ts"

const entityWith = (fields: Partial<EntityModel>): Map<string, EntityModel> => {
	const entities = new Map<string, EntityModel>()
	Object.assign(entityNamed(entities, fields.name ?? "note"), fields)
	return entities
}

describe("invertInvalidate", () => {
	it("adds each GET route a mutator invalidates to its entity's surface, once, and flags unknown ones", () => {
		const list = operation({ operationId: "notes.list", route: "GET /notes" })
		const create = operation({
			entity: "note",
			invalidates: ["GET /notes", "GET /notes", "POST /notes", "nonsense", "GET /gone"],
			operationId: "notes.create",
		})
		const quiet = operation({ entity: "note", invalidates: [] })
		const nameless = operation({ entity: null, invalidates: ["GET /notes"] })
		const entities = new Map<string, EntityModel>()
		const gaps = new GapCollector()
		invertInvalidate(entities, [create, quiet, nameless], new Map([["GET /notes", list]]), gaps)
		expect(entities.get("note")).toMatchObject({
			declaredSurface: ["GET /notes", "GET /gone"],
			readSurface: ["GET /notes", "GET /gone"],
		})
		expect(details(gaps, "x-invalidate")).toEqual(['names "GET /gone", which is not an operation in this document'])
	})
})

describe("fallBackToSiblings", () => {
	const routes: OperationModel[] = [
		operation({ operationId: "notes.list", route: "GET /notes" }),
		operation({ operationId: "notes.get", route: "GET /notes/{id}" }),
	]

	it("falls back to the list and read routes, flagging an entity with mutators", () => {
		const gaps = new GapCollector()
		const entities = entityWith({ create: "notes.create", list: "notes.list", read: "notes.get" })
		fallBackToSiblings(entities, routes, gaps)
		expect(entities.get("note")?.readSurface).toEqual(["GET /notes", "GET /notes/{id}"])
		expect(gaps.gaps).toEqual([
			{
				detail:
					'entity "note" has mutators but no declared read surface; falling back to sibling routes GET /notes, GET /notes/{id}',
				operationId: "notes.create",
				tag: "x-invalidate",
			},
		])
	})

	it("names the update or the delete when there is no create", () => {
		for (const mutator of [{ update: "notes.update" }, { delete: "notes.delete" }]) {
			const gaps = new GapCollector()
			fallBackToSiblings(entityWith({ list: "notes.list", ...mutator }), routes, gaps)
			expect(gaps.gaps[0]?.operationId).toBe(Object.values(mutator)[0])
		}
	})

	it("says nothing for an entity without mutators, one with no sibling routes, or one already declared", () => {
		const gaps = new GapCollector()
		fallBackToSiblings(entityWith({ read: "notes.get" }), routes, gaps)
		fallBackToSiblings(entityWith({ create: "notes.create", list: "missing" }), routes, gaps)
		const declared = entityWith({ create: "notes.create", list: "notes.list", readSurface: ["GET /x"] })
		fallBackToSiblings(declared, routes, gaps)
		expect(gaps.gaps).toEqual([])
		expect(declared.get("note")?.readSurface).toEqual(["GET /x"])
	})
})

describe("markTrackable", () => {
	it("tracks an entity with an identity, and flags a mutable one without", () => {
		const gaps = new GapCollector()
		const tracked = entityWith({ create: "notes.create", identity: "id" })
		markTrackable(tracked, gaps)
		markTrackable(entityWith({ name: "tag", update: "tags.update" }), gaps)
		markTrackable(entityWith({ name: "log", list: "logs.list" }), gaps)
		expect(tracked.get("note")?.trackable).toBe(true)
		expect(gaps.gaps.map((gap) => [gap.operationId, gap.tag])).toEqual([["tags.update", "x-entity.identity"]])
		expect(gaps.gaps[0]?.detail).toBe(
			'entity "tag" has no discoverable identity property, so instances cannot be tracked across projections; lifecycle and criss-cross coverage disabled',
		)
	})
})
