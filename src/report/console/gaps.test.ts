import { describe, expect, it } from "vitest"
import { documentOf, listOp, modelOf } from "./__fixtures__/models.ts"
import { doctorFacts } from "./doctor-facts.ts"
import { danglingRefLines, externalRefLines, gapLines } from "./gaps.ts"

const empty = doctorFacts(modelOf(documentOf({})).model)

describe("externalRefLines", () => {
	it("lists the references oat did not follow", () => {
		expect(externalRefLines([])).toEqual([])
		expect(externalRefLines(["other.yaml#/a"])).toEqual([
			"  unresolved external $refs (not fetched — a test tool should not follow arbitrary URLs)",
			"    other.yaml#/a",
			"",
		])
	})
})

describe("danglingRefLines", () => {
	it("lists each internal reference that points at nothing, once", () => {
		expect(danglingRefLines([])).toEqual([])
		expect(danglingRefLines(["#/components/schemas/Fee"])).toEqual([
			"  dangling $refs (nothing in the document is at these pointers; see the $ref gaps)",
			"    #/components/schemas/Fee",
			"",
		])
	})
})

const gap = (tag: string, n: number) => ({ detail: `detail ${n}`, operationId: `op.${n}`, tag })

describe("gapLines", () => {
	it("lists gaps by tag, most frequent first, four per tag, with the remedy or a pointer to the README", () => {
		const gapsByTag = new Map([
			["operationId", [gap("operationId", 1)]],
			["x-entity", [1, 2, 3, 4, 5, 6].map((n) => gap("x-entity", n))],
		])
		expect(gapLines({ ...empty, gapsByTag })).toEqual([
			"  gaps by tag",
			"    x-entity (6) — name the entity and action so this operation joins a lifecycle",
			"      op.1: detail 1",
			"      op.2: detail 2",
			"      op.3: detail 3",
			"      op.4: detail 4",
			"      … and 2 more",
			"    operationId (1) — see the README",
			"      op.1: detail 1",
			"",
		])
		expect(gapLines(empty)).toEqual([])
	})

	it("reads the gaps a document really has", () => {
		const duplicated = modelOf(
			documentOf({ "/a": { get: listOp("a", "same.id") }, "/b": { get: listOp("b", "same.id") } }),
		).model
		expect(gapLines(doctorFacts(duplicated))).toContain("    operationId (1) — see the README")
	})

	it("names each webhook, callback, link and additional operation, and says oat does not test it", () => {
		const subscribe = {
			...(listOp("a", "a.list") as object),
			callbacks: { onEvent: {} },
			responses: { "200": { description: "ok", links: { Next: { operationId: "a.list" } } } },
		}
		const doc = documentOf(
			{ "/a": { additionalOperations: { COPY: { responses: { "200": { description: "ok" } } } }, get: subscribe } },
			{ openapi: "3.2.0", webhooks: { newPet: { post: { responses: { "200": { description: "ok" } } } } } },
		)
		const lines = gapLines(doctorFacts(modelOf(doc).model))
		for (const expected of [
			"    webhooks (1) — not tested: oat makes no inbound or follow-up calls",
			"      webhook newPet: is a call the API sends to a subscriber's URL; oat receives no inbound call",
			"    callbacks (1) — not tested: oat makes no inbound or follow-up calls",
			'      a.list: declares callback "onEvent", a call the API makes back to a URL the request names',
			"    links (1) — not tested: oat makes no inbound or follow-up calls",
			'      a.list: response 200 links "Next" to a follow-up call oat does not make',
			"    additionalOperations (1) — not tested: oat sends only the methods OpenAPI fixes on a path item",
			"      COPY /a: declares method COPY under additionalOperations, which oat does not send",
		]) {
			expect(lines).toContain(expected)
		}
	})
})

describe("gapLines and a dangling $ref", () => {
	it("says what defining a dangling $ref closes", () => {
		const doc = documentOf({ "/a": { get: { ...(listOp("a", "a.list") as object), parameters: [{ $ref: "#/x" }] } } })
		expect(gapLines(doctorFacts(modelOf(doc).model))).toEqual(
			expect.arrayContaining([
				"    $ref (1) — define what each pointer names: a missing schema reads as unconstrained, a missing anything else leaves its operation untested",
				"      a.list: $ref #/x points at nothing; oat leaves this operation untested",
			]),
		)
	})
})
