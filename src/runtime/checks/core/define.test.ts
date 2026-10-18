import { describe, expect, it } from "vitest"
import { CHECK_IDS } from "../../check-ids.ts"
import type { Check } from "./check.ts"
import { buildRegistry, defineCheck } from "./define.ts"

const check = (id: string, dependsOn?: string[]): Check =>
	defineCheck({
		id: id as Check["id"],
		plan: () => ({ ok: false }),
		run: async () => ({ kind: "passed" }) as never,
		subjects: () => [],
		...(dependsOn === undefined ? {} : { dependsOn: dependsOn as Check["id"][] }),
	})

describe("defineCheck", () => {
	it("returns the check it is given, typed by its plan", () => {
		const defined = defineCheck<{ n: number }>({
			id: "list.read-after-write",
			plan: () => ({ ok: true, value: { n: 1 } }),
			run: async (_ctx, plan) => ({ kind: plan.n === 1 ? "passed" : "failed" }) as never,
			subjects: () => [],
		})
		expect(defined.id).toBe("list.read-after-write")
	})
})

const all = (): Check[] => CHECK_IDS.map((id) => check(id))

describe("buildRegistry", () => {
	it("returns the checks in order when every id is there once, dependencies first", () => {
		const [first, second] = CHECK_IDS
		const checks = [check(first), check(second, [first]), ...all().slice(2)]
		expect(buildRegistry(checks).map((c) => c.id)).toEqual(checks.map((c) => c.id))
	})

	it("refuses a dependency registered after the check that names it", () => {
		const [first, second] = CHECK_IDS
		expect(() => buildRegistry([check(first, [second]), check(second), ...all().slice(2)])).toThrow(
			/registered after it/,
		)
	})
})
