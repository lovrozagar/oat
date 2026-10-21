import { describe, expect, it } from "vitest"
import { CHECK_IDS, type CheckId } from "../../check-ids.ts"
import type { Check, OperationCheck, RegisteredCheck } from "./check.ts"
import { entityChecks, operationChecks, validateRegistry } from "./registry.ts"

const stub = (id: string, dependsOn?: string[]): Check =>
	({
		id,
		plan: () => ({ ok: false }),
		run: async () => ({ kind: "passed" }),
		subjects: () => [],
		...(dependsOn === undefined ? {} : { dependsOn }),
	}) as unknown as Check

const operationStub = (id: string): OperationCheck =>
	({
		id,
		plan: () => ({ ok: false }),
		run: async () => ({ kind: "asserted" }),
		subject: "operation",
	}) as unknown as OperationCheck

/* One stub per id the registry must hold, in id order. */
const ALL: readonly Check[] = CHECK_IDS.map((id: CheckId) => stub(id))

describe("validateRegistry", () => {
	it("accepts every id once, with each dependency registered earlier", () => {
		const [first, second] = CHECK_IDS
		expect(() => validateRegistry([stub(first), stub(second, [first]), ...ALL.slice(2)])).not.toThrow()
	})

	it("refuses a dependency registered after the check that names it", () => {
		const [first, second] = CHECK_IDS
		expect(() => validateRegistry([stub(first, [second]), stub(second), ...ALL.slice(2)])).toThrow(
			/registered after it/,
		)
	})

	it("refuses a dependency that is not registered at all", () => {
		expect(() => validateRegistry([stub(CHECK_IDS[0], ["nothing.here"]), ...ALL.slice(1)])).toThrow(
			/which is not registered/,
		)
	})

	it("refuses a duplicate id and an id that is never registered", () => {
		expect(() => validateRegistry([...ALL, stub(CHECK_IDS[0])])).toThrow(/registered twice/)
		expect(() => validateRegistry(ALL.slice(1))).toThrow(/never registered/)
	})

	it("accepts operation checks in the same list, and refuses one registered twice", () => {
		const [first] = CHECK_IDS
		const mixed: RegisteredCheck[] = [operationStub(first), ...ALL.slice(1)]
		expect(() => validateRegistry(mixed)).not.toThrow()
		expect(() => validateRegistry([...mixed, operationStub(first)])).toThrow(/registered twice/)
	})
})

describe("entityChecks and operationChecks", () => {
	it("split the registry by subject, each keeping registry order", () => {
		const [first, second, third] = CHECK_IDS
		const entity = { ...stub(second), subject: "entity" } as Check
		const registry: RegisteredCheck[] = [operationStub(first), entity, stub(third)]
		expect(entityChecks(registry).map((check) => check.id)).toEqual([second, third])
		expect(operationChecks(registry).map((check) => check.id)).toEqual([first])
	})
})
