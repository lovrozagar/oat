import { describe, expect, it } from "vitest"
import { buildModel } from "../spec/graph/build.ts"
import { dereference } from "../spec/load/dereference.ts"
import { extractSpec } from "./effects.ts"

describe("the effects suite's document", () => {
	it("builds into a model whose extract operation declares its effects", () => {
		const model = buildModel(dereference(extractSpec()).doc)
		const declaring = model.operations.filter((op) => op.effects.length > 0)
		expect(declaring.length).toBeGreaterThan(0)
	})
})
