import { describe, expect, it } from "vitest"
import type { OwnRecords } from "../own-record.ts"
import { me, selfInput } from "./__fixtures__/me.ts"
import { actingAs } from "./guard.ts"
import type { SelfRun } from "./verdicts.ts"

/* Who the self check acts as: the caller, leaving alone what it signs in with, or a disposable principal. */

const ACCOUNT = { properties: { bio: { type: "string" }, password: { type: "string" } }, type: "object" }
const ONLY_PASSWORD = { properties: { password: { type: "string" } }, type: "object" }
const SIGNS_UP = { properties: { email: { type: "string" } }, required: ["email"], type: "object" }

/** alpha's guard: it signs in with its email; a write that needs it gets `disposable`. */
const records = (disposable: string | { blocked: string }): OwnRecords => ({
	disposable: async () => disposable,
	identityOf: (principal) => (principal === "alpha" ? { email: "ann@x.io" } : undefined),
	signIn: new Set(["email"]),
})

/** The check's input and run over a `/me` document shaped by `options`. */
function acting(options: Parameters<typeof me>[0], guard: OwnRecords | undefined) {
	const { input, model, findings } = selfInput(
		() => undefined,
		me(options),
		guard === undefined ? {} : { ownRecords: guard },
	)
	const op = (id: string) => model.byOperationId.get(id)
	const run = { entity: input.entity, findings, updateOp: op("me.update") } as unknown as SelfRun
	return { findings, result: actingAs(input, run) }
}

describe("actingAs", () => {
	it("acts as the caller with nothing to avoid, when no guard knows it", async () => {
		expect(await acting({ update: ACCOUNT }, undefined).result).toEqual({ avoid: new Set(), principal: "alpha" })
		const stranger = { ...records("d"), identityOf: () => undefined }
		expect(await acting({ update: ACCOUNT }, stranger).result).toEqual({ avoid: new Set(), principal: "alpha" })
	})

	it("acts as the caller, avoiding its password, while another field is there to change", async () => {
		expect(await acting({ update: ACCOUNT }, records("d")).result).toEqual({
			avoid: new Set(["password"]),
			principal: "alpha",
		})
	})

	it("acts as the disposable principal when the only field to change, or one a create requires, is protected", async () => {
		expect(await acting({ update: ONLY_PASSWORD }, records("disposable-own-record")).result).toEqual({
			avoid: new Set(),
			principal: "disposable-own-record",
		})
		expect(await acting({ create: SIGNS_UP, update: false }, records("disposable-own-record")).result).toEqual({
			avoid: new Set(),
			principal: "disposable-own-record",
		})
	})

	it("acts as the caller when the create requires nothing it signs in with, or the update names no properties", async () => {
		const bio = { properties: { bio: { type: "string" } }, type: "object" }
		for (const create of [bio, { ...bio, required: ["bio"] }]) {
			expect(await acting({ create, update: ACCOUNT }, records("d")).result).toEqual({
				avoid: new Set(["password"]),
				principal: "alpha",
			})
		}
		expect(await acting({ update: { type: "object" } }, records("d")).result).toEqual({
			avoid: new Set(),
			principal: "alpha",
		})
	})

	it("stands down, naming the field, when no disposable principal could sign up", async () => {
		const { findings, result } = acting({ update: ONLY_PASSWORD }, records({ blocked: "no x-fresh-principal" }))
		await result
		expect(findings.inconclusive.map((entry) => entry.reason)).toEqual([
			expect.stringMatching(/me\.update would change password on alpha's own record.*no x-fresh-principal$/),
		])
	})
})
