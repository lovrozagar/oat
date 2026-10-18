import { describe, expect, it } from "vitest"
import { modelOf } from "../checks/__fixtures__/harness.ts"
import type { EntityModel } from "../../spec/graph/types.ts"
import { me } from "./__fixtures__/me.ts"
import {
	entityIsSelf,
	SELF_CHECK_ID,
	SELF_IDENTITY,
	selfActionIds,
	selfOperationIds,
	selfReadIds,
} from "./operations.ts"

/* The entity without the given operations, as a document that lacks them would model it. */
const omit = <T extends object>(value: T, ...keys: Array<keyof T>): T =>
	Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as keyof T))) as T

const profile = (document = me()): { entity: EntityModel; model: ReturnType<typeof modelOf> } => {
	const model = modelOf(document)
	return { entity: model.entities.get("profile") as EntityModel, model }
}

describe("the caller's operations", () => {
	it("names the check and the identity it is about", () => {
		expect(SELF_IDENTITY).toBe("self")
		expect(SELF_CHECK_ID).toBe("auth.self-is-the-caller")
	})

	it("reads through every read, or the one read, or none", () => {
		const { entity } = profile(me({ secondRead: "/me/settings" }))
		expect(selfReadIds(entity)).toEqual(["me.get", "me.settings"])
		expect(selfReadIds({ ...entity, reads: [] })).toEqual(["me.get"])
		expect(selfReadIds(omit(entity, "read", "reads"))).toEqual([])
	})

	it("acts through GET actions with no path id, on a self entity only", () => {
		const { entity, model } = profile(me({ action: ["handle"] }))
		expect(selfActionIds(entity, model)).toEqual(["me.lookup"])
		expect(selfActionIds({ ...entity, actions: ["me.update", "missing"] }, model)).toEqual([])
		expect(selfActionIds({ ...entity, identity: "id" }, model)).toEqual([])
	})

	it("lists the create first, then the reads, the update and the actions", () => {
		const { entity, model } = profile(me({ action: ["handle"], create: { type: "object" } }))
		expect(selfOperationIds(entity, model)).toEqual(["me.create", "me.get", "me.update", "me.lookup"])
		expect(selfOperationIds(entity)).toEqual(["me.create", "me.get", "me.update"])
		expect(selfOperationIds(omit(entity, "read", "reads", "update"), model)).toEqual(["me.lookup"])
		expect(selfOperationIds({ ...entity, identity: "id" }, model)).toEqual([])
	})

	it("is a self entity when it has an operation to judge", () => {
		const { entity } = profile()
		expect(entityIsSelf(entity)).toBe(true)
		expect(entityIsSelf(omit(entity, "read", "reads", "update"))).toBe(false)
	})
})
