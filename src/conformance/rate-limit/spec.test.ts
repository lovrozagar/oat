import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import type { OperationObject } from "../../spec/types.ts"
import { planLimitSpec, thingSpec } from "./spec.ts"

const operations = (doc: ReturnType<typeof thingSpec>) =>
	buildModel(dereference(doc).doc)
		.operations.map((op) => op.operationId)
		.toSorted()

describe("the rate-limit suite's documents", () => {
	it("model untagged things with full CRUD", () => {
		expect(operations(thingSpec())).toEqual(["thing.create", "thing.delete", "thing.list", "thing.read"])
	})

	it("model tables, whose create documents a 402, and the rows inside them", () => {
		expect(operations(planLimitSpec())).toEqual([
			"row.create",
			"row.delete",
			"row.list",
			"row.read",
			"table.create",
			"table.delete",
			"table.list",
			"table.read",
		])
		const created = planLimitSpec().paths?.["/v1/tables"]?.post as OperationObject | undefined
		expect(Object.keys(created?.responses ?? {})).toEqual(["201", "402"])
	})
})
