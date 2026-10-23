import { describe, expect, it } from "vitest"
import { anyrow } from "../../spec/security/__fixtures__/documents.ts"
import { documentOf, modelOf, referenceModel } from "./__fixtures__/models.ts"
import { doctor, unsetEnvLines } from "./doctor.ts"

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
			"security",
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

describe("doctor on what oat does not exercise", () => {
	it("names a webhook in text and JSON, without blocking or claiming full coverage", () => {
		const { model } = modelOf(documentOf({}, { webhooks: { newPet: { post: {} } } }))
		const { text, blocking } = doctor(model)
		expect(blocking).toBe(0)
		expect(text).toContain("    webhooks (1) — not tested: oat makes no inbound or follow-up calls")
		expect(text).not.toContain("no gaps")
		expect(JSON.parse(doctor(model, { asJson: true }).text).gaps).toEqual([
			{
				detail: "is a call the API sends to a subscriber's URL; oat receives no inbound call",
				operationId: "webhook newPet",
				tag: "webhooks",
			},
		])
	})
})

describe("doctor and credentials", () => {
	const legacy = documentOf(
		{
			"/a": { get: { operationId: "a.get", responses: { "200": { description: "ok" } }, security: [{ legacy: [] }] } },
		},
		{ components: { securitySchemes: { legacy: { in: "header", name: "X-Legacy", type: "apiKey" } } } },
	)

	it("with a config, unsatisfiable operations block", () => {
		const { model } = modelOf(legacy)
		const credentials = { principals: { alpha: {} }, security: {} }
		const { text, blocking } = doctor(model, { config: { credentials } })
		expect(blocking).toBe(1)
		expect(text).toContain("    legacy                          1   none — no credential for legacy\n")
		expect(text).toContain(
			"  no recipe — operations needing only these are untested\n    legacy     1 operation; add security.legacy\n",
		)
		expect(doctor(model).blocking).toBe(0)
		expect(doctor(model, { config: {} }).blocking).toBe(0)
	})

	it("prints the security block after auth, and leaves it out where the document declares and names no scheme", () => {
		const text = doctor(modelOf(anyrow).model).text
		expect(text.indexOf("  security — 2 schemes")).toBeGreaterThan(-1)
		expect(text).toContain("    jwt | apiKey[rows:read]         1\n")
		expect(doctor(modelOf(documentOf({})).model).text).not.toContain("  security — ")
	})

	it("notes unset variables in text and JSON, never blocking", () => {
		const { model } = modelOf(anyrow)
		const unsetEnv = ["OAT_JWT_TOKEN", "OAT_API_KEY_KEY"]
		const { text, blocking } = doctor(model, { unsetEnv })
		expect(blocking).toBe(0)
		expect(text).toContain("\n  env        OAT_JWT_TOKEN, OAT_API_KEY_KEY not set — a run stops until they are\n")
		const json = JSON.parse(doctor(model, { asJson: true, unsetEnv }).text)
		expect(json.unsetEnv).toEqual(unsetEnv)
		expect(Object.keys(json.security)).toEqual(["schemes", "operations", "unsupported", "undeclared"])
		expect(JSON.parse(doctor(model, { asJson: true }).text).unsetEnv).toBeUndefined()
		expect(unsetEnvLines([])).toEqual([])
		expect(unsetEnvLines(undefined)).toEqual([])
	})
})
