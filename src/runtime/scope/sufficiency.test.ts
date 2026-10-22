import { describe, expect, it } from "vitest"
import type { PassEvidence } from "../grades.ts"
import { sufficiencyOf } from "./sufficiency.ts"

const op = (method: string, fields: { effects?: unknown[]; noEffects?: boolean } = {}) =>
	({ effects: fields.effects ?? [], method, noEffects: fields.noEffects ?? false }) as never
const contract = {} as PassEvidence

describe("sufficiencyOf", () => {
	it("is verified once a later exchange shows the call's effect", () => {
		expect(sufficiencyOf(op("POST"), { observation: {} } as PassEvidence).sufficiency).toBe("verified")
	})

	it("is complete for a call that declares no effects, or a read with none", () => {
		expect(sufficiencyOf(op("POST", { noEffects: true }), contract)).toEqual({
			sufficiency: "complete",
			why: "declares no effects, so its contract is the whole promise",
		})
		expect(sufficiencyOf(op("get"), contract).sufficiency).toBe("complete")
		expect(sufficiencyOf(op("QUERY"), contract).sufficiency).toBe("complete")
	})

	it("is unproven for a write whose change nothing observed", () => {
		expect(sufficiencyOf(op("PATCH"), contract)).toEqual({
			sufficiency: "unproven",
			why: "met its contract, but no later read observed what it changed",
		})
		expect(sufficiencyOf(op("GET", { effects: [{}] }), contract)).toEqual({
			sufficiency: "unproven",
			why: "declares effects that no later read observed",
		})
	})
})
