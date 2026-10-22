import { describe, expect, it } from "vitest"
import { documentOf, listOp, modelOf, readOp, referenceModel } from "./__fixtures__/models.ts"
import { declaredTags, TAG_REMEDY, TAG_SHARPENS, TAG_UNLOCKS } from "./tags.ts"

describe("the tag tables", () => {
	it("promise each check under one tag only, and name a remedy or an effect in words", () => {
		const promised = Object.values(TAG_UNLOCKS).flat()
		expect(new Set(promised).size).toBe(promised.length)
		expect(Object.values(TAG_UNLOCKS).every((checks) => checks.length > 0)).toBe(true)
		expect(Object.keys(TAG_SHARPENS)).toEqual(["x-query", "x-tenant"])
		expect(Object.values(TAG_REMEDY).every((remedy) => remedy.length > 20)).toBe(true)
	})

	it("say plainly that what oat never calls is not tested", () => {
		for (const tag of ["webhooks", "callbacks", "links", "additionalOperations"]) {
			expect(TAG_REMEDY[tag]).toMatch(/^not tested: oat /)
		}
	})
})

describe("declaredTags", () => {
	it("finds every tag the reference declares, and none once its tags are stripped", async () => {
		const tagged = declaredTags((await referenceModel()).model)
		for (const tag of [
			"x-async",
			"x-effects",
			"x-immutable",
			"x-invalidate",
			"x-soft-delete",
			"x-wait",
			"x-tenant",
			"x-query",
			"x-unique",
			"x-invite",
			"x-entity",
		]) {
			expect(tagged.has(tag)).toBe(true)
		}
		expect([...declaredTags((await referenceModel({ untagged: true })).model)]).toEqual([])
	})

	it("counts x-entity only where it names the caller as the record", () => {
		const declared = declaredTags(
			modelOf(
				documentOf({
					"/notes": { get: listOp("note", "notes.list") },
					"/notes/{id}": { get: readOp("note", "notes.get") },
				}),
			).model,
		)
		expect(declared.has("x-entity")).toBe(false)
	})
})
