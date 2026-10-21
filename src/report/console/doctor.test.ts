import { describe, expect, it } from "vitest"
import { documentOf, modelOf, referenceModel } from "./__fixtures__/models.ts"
import { doctor } from "./doctor.ts"

describe("doctor as text", () => {
	it("reports what oat can and cannot test in the reference, section by section, and blocks on its roots", async () => {
		const { model, externalRefs } = await referenceModel()
		const { text, blocking } = doctor(model, { externalRefs })
		expect(blocking).toBe(1)
		const sections = [
			"  trackable",
			"  2 check(s) cannot run",
			"  roots required in config",
			"  unique constraints",
			"  invite — accept mode",
			"  query catalog",
			"  gaps by tag",
		].map((heading) => text.indexOf(heading))
		expect(sections.every((index) => index >= 0)).toBe(true)
		expect(sections).toEqual([...sections].sort((a, b) => a - b))
		expect(text).not.toContain("no gaps")
	})

	it("says a document with nothing missing has full coverage available", () => {
		const { text, blocking } = doctor(modelOf(documentOf({})).model, { config: { allowRemoved: [] } })
		expect(blocking).toBe(0)
		expect(text.split("\n").slice(0, 2)).toEqual(["", "  allow      0 operations removed"])
		expect(text.endsWith("  no gaps — full coverage available\n")).toBe(true)
	})
})

describe("doctor as JSON", () => {
	it("carries the counts, declarations, gaps and catalog in a stable order", async () => {
		const { model } = await referenceModel()
		const { text, blocking } = doctor(model, {
			asJson: true,
			config: { allowRemoved: ["a.b"], entities: { ghost: {} } },
			externalRefs: ["x.yaml"],
		})
		const json = JSON.parse(text)
		expect(Object.keys(json)).toEqual([
			"blocking",
			"entities",
			"externalRefs",
			"featureGates",
			"invites",
			"uniqueConstraints",
			"gaps",
			"listableEntities",
			"queryCatalog",
			"allowRemoved",
			"roots",
			"testableEntities",
			"trackableEntities",
			"unknownEntities",
		])
		/* The reference reads its API keys back (apiKey.get), so api-key is a trackable entity of its own. */
		expect(json).toMatchObject({
			allowRemoved: ["a.b"],
			blocking,
			entities: 7,
			externalRefs: ["x.yaml"],
			invites: [{ accept: "invite.accept", acceptFrom: "token", entity: "table" }],
			listableEntities: 4,
			testableEntities: 7,
			trackableEntities: 7,
			unknownEntities: ["ghost"],
		})
		expect(text.endsWith("}\n")).toBe(true)
	})

	it("says how a link invite is accepted, and leaves out an allow list config did not give", async () => {
		const { model } = await referenceModel()
		for (const entity of model.entities.values()) {
			if (entity.invite !== null) entity.invite = { ...entity.invite, acceptFrom: "link" }
		}
		const json = JSON.parse(doctor(model, { asJson: true }).text)
		expect(json.invites[0].acceptFrom).toBe("link")
		expect(json.allowRemoved).toBeUndefined()
	})
})
