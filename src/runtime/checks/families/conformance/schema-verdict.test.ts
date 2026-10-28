import { describe, expect, it } from "vitest"
import type { OperationObject } from "../../../../spec/types.ts"
import { SchemaValidator } from "../../../validate.ts"
import { modelOfItems, seen, UNCOMPILABLE, unnamed } from "./__fixtures__/items.ts"
import { captureVerdict, verdictOf } from "./schema-verdict.ts"

const model = modelOfItems()
const validator = new SchemaValidator(model.defs)
const read = { operationId: "item.read", raw: model.rawOperations.get("item.read") as OperationObject }

describe("captureVerdict", () => {
	it("validates a body against the schema its operation documents for the status", () => {
		const capture = captureVerdict(validator, model)
		expect(capture(seen("item.read", { body: { id: "1", name: "a" }, status: 200 }))).toEqual({ errors: [] })
		expect(capture(seen("item.read", { body: { id: "1", name: 7 }, status: 200 }))).toEqual({
			errors: ["/name must be string"],
		})
	})

	it("gives no verdict where nothing is documented, and says when the schema cannot compile", () => {
		const capture = captureVerdict(validator, model)
		expect(capture(seen("item.read", { body: {}, status: 418 }))).toBeUndefined()
		expect(capture(seen("nothing.here", { body: {}, status: 200 }))).toBeUndefined()
		expect(capture(unnamed({ body: {}, status: 200 }))).toBeUndefined()
		const broken = modelOfItems({ read: UNCOMPILABLE })
		const verdict = captureVerdict(
			new SchemaValidator(broken.defs),
			broken,
		)(seen("item.read", { body: "x", status: 200 }))
		expect(verdict).toMatchObject({ errors: [], unchecked: expect.any(String) })
	})
})

describe("verdictOf", () => {
	it("reads the verdict taken at capture, and validates a body that has none", () => {
		const ref = { bytes: 300_000, mediaType: "application/json", sha256: "a".repeat(64) }
		const held = (verdict: { errors: string[]; unchecked?: string }) =>
			seen("item.read", { body: ref, status: 200 }, { schemaVerdict: verdict })
		expect(verdictOf(validator, read, held({ errors: ["/name must be string"] }))).toEqual({
			errors: ["/name must be string"],
			ok: false,
		})
		expect(verdictOf(validator, read, held({ errors: [] }))).toEqual({ errors: [], ok: true })
		expect(verdictOf(validator, read, held({ errors: [], unchecked: "bad pattern" }))).toEqual({
			errors: [],
			ok: true,
			unchecked: "bad pattern",
		})
		expect(verdictOf(validator, read, seen("item.read", { body: { id: "1", name: "a" }, status: 200 }))).toEqual({
			errors: [],
			ok: true,
		})
	})
})
