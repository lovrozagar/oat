import { describe, expect, it } from "vitest"
import type { MintRecipe } from "../../config/types/security.ts"
import { answerOf, ctxOf, fakePorts, NOW, rejection } from "../__fixtures__/ports.ts"
import { RefusedAnswer } from "./answer.ts"
import { acquireMint } from "./mint.ts"

const mint: MintRecipe = {
	body: { label: "oat {principal.email}", note: "for {scopes}", scopes: "{scopes}", tags: ["oat", 1, null] },
	from: "$.key",
	operationId: "apiKey.create",
	revoke: "apiKey.revoke",
	with: "jwt",
}
const AS_JWT = { principal: "ann", scheme: "jwt" }

describe("acquireMint", () => {
	it("calls the operation as the principal with the `with` scheme, and the scope set in the body", async () => {
		const { ports, recorded } = fakePorts({ call: () => Promise.resolve(answerOf({ id: 7, key: "k1" }, 201)) })
		const issued = await acquireMint(ctxOf(ports, { scopes: ["rows:read", "rows:write"] }), mint, {})
		expect([issued.value, issued.expiresAt, issued.scopes]).toEqual(["k1", null, ["rows:read", "rows:write"]])
		expect(recorded.calls).toEqual([
			{
				body: {
					label: "oat ann@x.io",
					note: "for rows:read rows:write",
					scopes: ["rows:read", "rows:write"],
					tags: ["oat", 1, null],
				},
				as: AS_JWT,
				operationId: "apiKey.create",
				secrets: ["$.key"],
			},
		])
	})

	it("registers each identity value its body sends as a secret before it calls", async () => {
		let before: string[] = []
		const { ports, recorded } = fakePorts({
			call: () => {
				before = [...recorded.secrets]
				return Promise.resolve(answerOf({ key: "k1" }))
			},
		})
		await acquireMint(ctxOf(ports), mint, {})
		expect([before, recorded.secrets]).toEqual([["ann@x.io"], ["ann@x.io"]])
	})

	it("sends no body when the recipe has none, and takes `expiresIn`", async () => {
		const { ports, recorded } = fakePorts({ call: () => Promise.resolve(answerOf({ key: "k" })) })
		const bare: MintRecipe = { from: "$.key", operationId: "apiKey.create", with: "jwt" }
		const issued = await acquireMint(ctxOf(ports), bare, { expiresIn: 60 })
		expect([issued.expiresAt, issued.revoke, recorded.calls[0]]).toEqual([
			NOW + 60_000,
			undefined,
			{ as: AS_JWT, operationId: "apiKey.create", secrets: ["$.key"] },
		])
		expect(recorded.secrets).toEqual([])
	})
})

describe("acquireMint: revoke and failures", () => {
	it("revokes by the `revoke` operation, with the minted value and the answer's fields as its scope", async () => {
		const answers = [answerOf({ id: 7, key: "k1", meta: { a: 1 } }, 201), answerOf(null, 204)]
		const { ports, recorded } = fakePorts({ call: () => Promise.resolve(answers.shift() ?? answerOf(null, 404)) })
		const issued = await acquireMint(ctxOf(ports), mint, {})
		await (issued.revoke as () => Promise<void>)()
		expect(recorded.calls[1]).toEqual({
			as: AS_JWT,
			operationId: "apiKey.revoke",
			scope: { credential: "k1", id: "7", key: "k1" },
		})
		const refused = await rejection((issued.revoke as () => Promise<void>)())
		expect([refused.message, refused instanceof RefusedAnswer && refused.status]).toEqual([
			"revoke apiKey.revoke answered 404",
			404,
		])
	})

	it("revokes a key minted into a header with the minted value alone as its scope", async () => {
		const minted = { ...answerOf(null, 201), headers: { "x-api-key": "k2" } }
		const answers = [minted, answerOf(null, 204)]
		const { ports, recorded } = fakePorts({ call: () => Promise.resolve(answers.shift() ?? minted) })
		const issued = await acquireMint(ctxOf(ports), { ...mint, from: "header:x-api-key" }, {})
		await (issued.revoke as () => Promise<void>)()
		expect([issued.value, recorded.calls[1]?.scope]).toEqual(["k2", { credential: "k2" }])
	})

	it("reads the minted key and its lifetime from a form answer, by its media type", async () => {
		const headers = { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }
		const answer = { ...answerOf("key=k-form&ttl=60", 201), headers }
		const { ports } = fakePorts({ call: () => Promise.resolve(answer) })
		const issued = await acquireMint(ctxOf(ports), { ...mint, from: "key" }, { expiresIn: { from: "ttl" } })
		expect([issued.value, issued.expiresAt]).toEqual(["k-form", NOW + 60_000])
	})

	it("fails with the reason on a refused mint or one that answers no credential", async () => {
		const answers = [answerOf({ error: "nope" }, 403), answerOf({})]
		const { ports } = fakePorts({ call: () => Promise.resolve(answers.shift() ?? answerOf({})) })
		expect((await rejection(acquireMint(ctxOf(ports), mint, {}))).message).toBe("mint apiKey.create answered 403")
		expect((await rejection(acquireMint(ctxOf(ports), mint, {}))).message).toBe(
			"mint apiKey.create answered no credential at $.key (its answer names no content type)",
		)
	})

	it("fails with the caller's reason when the `with` scheme has no credential", async () => {
		const { ports } = fakePorts({ call: () => Promise.reject(new Error('principal "ann" is blocked for jwt')) })
		expect((await rejection(acquireMint(ctxOf(ports), mint, {}))).message).toBe('principal "ann" is blocked for jwt')
	})
})

describe("acquireMint: the record a revoke removes", () => {
	it("names the record its revoke removes: the revoke operation, its scope, and who sends it", async () => {
		const { ports } = fakePorts({ call: () => Promise.resolve(answerOf({ id: 7, key: "k1" }, 201)) })
		const issued = await acquireMint(ctxOf(ports), mint, {})
		expect(issued.record).toEqual({
			as: AS_JWT,
			operationId: "apiKey.revoke",
			scope: { credential: "k1", id: "7", key: "k1" },
		})
		const bare = await acquireMint(ctxOf(ports), { from: "$.key", operationId: "apiKey.create", with: "jwt" }, {})
		expect(bare.record).toBeUndefined()
	})
})
