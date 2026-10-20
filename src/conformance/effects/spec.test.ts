import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { bearerSecurity } from "../harness/security.ts"
import { extractSpec } from "./spec.ts"

describe("the effects suite's document", () => {
	it("builds into a model whose extract operation declares its effects", () => {
		const model = buildModel(dereference(extractSpec()).doc)
		const declaring = model.operations.filter((op) => op.effects.length > 0)
		expect(declaring.map((op) => op.operationId)).toEqual(["extract.once"])
		expect(model.operations.map((op) => op.operationId).toSorted()).toEqual([
			"extract.once",
			"row.list",
			"table.create",
			"table.list",
			"table.read",
		])
	})
})

describe("the effects suite's document security", () => {
	it("requires the bearer on every operation, from the root", () => {
		const doc = extractSpec()
		expect(doc).toMatchObject(bearerSecurity())
		const sources = buildModel(dereference(doc).doc).operations.map((op) => op.security.source)
		expect(new Set(sources)).toEqual(new Set(["root"]))
	})
})
