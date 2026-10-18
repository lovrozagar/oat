import { describe, expect, it } from "vitest"
import { documentOf, FILTER_TEMPLATE, listOp, modelOf, referenceModel, SORT_TEMPLATE } from "./__fixtures__/models.ts"
import {
	bar,
	declaredGrammars,
	hasInvite,
	inviteAcceptMode,
	lifecycleGlyphs,
	listOperation,
	sortedEntities,
} from "./describe.ts"

describe("bar", () => {
	it("fills its share of the width, and draws a rule over nothing", () => {
		expect(bar(1, 2, 4)).toBe("██░░")
		expect(bar(3, 3)).toBe("█".repeat(24))
		expect(bar(0, 0, 3)).toBe("───")
	})
})

describe("lifecycleGlyphs", () => {
	it("letters the operations an entity has and dots the rest", async () => {
		const { model } = await referenceModel()
		const glyphs = sortedEntities(model).map((entity) => `${entity.name} ${lifecycleGlyphs(entity)}`)
		expect(glyphs).toContain("table CLRUD")
		expect(glyphs).toContain("profile ··RU·")
	})
})

describe("invites", () => {
	it("are accepted by link or by posting the token", async () => {
		const { model } = await referenceModel()
		const inviting = sortedEntities(model).filter(hasInvite)
		expect(inviting.map((entity) => entity.name)).toEqual(["table"])
		const invite = inviting[0]?.invite
		expect(invite === undefined ? "" : inviteAcceptMode(invite)).toBe("JSON token → invite.accept")
		expect(inviteAcceptMode({ ...(invite as NonNullable<typeof invite>), acceptFrom: "link" })).toBe(
			"GET-link (x-invite.acceptFrom: link)",
		)
	})
})

describe("sortedEntities and listOperation", () => {
	it("order entities by name and find each list operation", async () => {
		const { model } = await referenceModel()
		const names = sortedEntities(model).map((entity) => entity.name)
		expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
		expect(listOperation(model, "table.list").operationId).toBe("table.list")
	})
})

describe("declaredGrammars", () => {
	it("is empty when no list declares a template", async () => {
		expect(declaredGrammars((await referenceModel()).model)).toEqual([])
	})

	it("describes the filter and sort templates a dialect declares, per listable entity", async () => {
		const grammars = declaredGrammars((await referenceModel({ dialect: "template" })).model)
		expect(grammars.map((row) => row.entity)).toEqual(["job", "row", "table"])
		expect(grammars.every((row) => row.filter !== undefined && row.sort !== undefined)).toBe(true)
	})

	it("keeps a filter template without a sort one, and the reverse", () => {
		const doc = documentOf({
			"/a": { get: listOp("a", "a.list", { "x-query": { grammar: FILTER_TEMPLATE } }) },
			"/b": { get: listOp("b", "b.list") },
		})
		const { model } = modelOf(doc, { entities: { b: { query: { sortGrammar: SORT_TEMPLATE } } } })
		const grammars = declaredGrammars(model)
		expect(grammars).toHaveLength(2)
		expect(grammars[0]).toMatchObject({ entity: "a" })
		expect(grammars[0]?.sort).toBeUndefined()
		expect(grammars[1]).toMatchObject({ entity: "b" })
		expect(grammars[1]?.filter).toBeUndefined()
	})
})
