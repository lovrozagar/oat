import { describe, expect, it } from "vitest"
import { doc, ok } from "../__fixtures__/documents.ts"
import type { OpenApiDocument } from "../types.ts"
import { DEFS_KEY, documentDefs } from "./defs.ts"
import { EXTERNAL_KEY } from "./bundle.ts"
import { dereference } from "./dereference.ts"

const node = { properties: { child: { $ref: "#/components/schemas/Node" }, id: { type: "string" } }, type: "object" }
const paths = { "/nodes": { get: { operationId: "nodes.get", responses: ok({ $ref: "#/components/schemas/Node" }) } } }

const sorted = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort())

/* The success schema of `GET /nodes` in a dereferenced document. */
const nodesSchema = (out: OpenApiDocument): unknown => {
	const item = out.paths?.["/nodes"] as { get: { responses: Record<string, any> } }
	return item.get.responses["200"].content["application/json"].schema
}

describe("dereference", () => {
	it("inlines refs, stores a recursive schema once, and reports external refs", () => {
		const source = doc(paths, {
			components: { schemas: { Ext: { $ref: "other.yaml#/X" }, Node: node } },
		})
		const { doc: out, externalRefs } = dereference(source)
		const schema = nodesSchema(out)
		expect(schema).toEqual({
			properties: { child: { $ref: "oat-defs#/$defs/Node" }, id: { type: "string" } },
			type: "object",
		})
		expect(documentDefs(out)).toEqual({ Node: schema })
		expect(externalRefs).toEqual(["other.yaml#/X"])
		expect(JSON.stringify(out)).not.toContain('"#/')
	})

	it("gives the same result whatever order the document lists its keys in", () => {
		const before = { components: { schemas: { Node: node } }, openapi: "3.1.0", paths } as OpenApiDocument
		const after = { openapi: "3.1.0", paths, components: { schemas: { Node: node } } } as OpenApiDocument
		expect(sorted(dereference(before).doc.paths)).toBe(sorted(dereference(after).doc.paths))
	})

	it("adds no definitions to a document without recursion", () => {
		expect(DEFS_KEY in dereference(doc(paths, { components: { schemas: { Node: { type: "object" } } } })).doc).toBe(
			false,
		)
	})

	it("drops the files bundled beside the document once their refs are inlined, keeping their recursion", () => {
		const pet = { properties: { parent: { $ref: "#/x-oat-external/pet.yaml/Pet" } }, type: "object" }
		const refs = { $ref: "#/x-oat-external/pet.yaml/Pet" }
		const source = doc(
			{ "/pets": { get: { operationId: "pets.get", responses: ok(refs) } } },
			{
				[EXTERNAL_KEY]: { "pet.yaml": { Pet: pet } },
			},
		)
		const { doc: out } = dereference(source)
		expect(EXTERNAL_KEY in out).toBe(false)
		expect(documentDefs(out)).toEqual({
			Pet: { properties: { parent: { $ref: "oat-defs#/$defs/Pet" } }, type: "object" },
		})
	})

	it("stores the document itself, without its definitions, when a ref names it", () => {
		const { doc: out } = dereference(doc({}, { "x-self": { $ref: "#" } }))
		const self = documentDefs(out)["_"] as Record<string, unknown>
		expect(self["x-self"]).toEqual({ $ref: "oat-defs#/$defs/_" })
		expect(DEFS_KEY in self).toBe(false)
		expect(self).not.toBe(out)
	})

	it("stores an Example Object that refers to itself, walking it again for its definition", () => {
		const loop = { value: 1, "x-loop": { $ref: "#/components/examples/Loop" } }
		const { doc: out } = dereference(doc({}, { components: { examples: { Loop: loop } } }))
		expect(documentDefs(out)).toEqual({ Loop: { value: 1, "x-loop": { $ref: "oat-defs#/$defs/Loop" } } })
	})
})
