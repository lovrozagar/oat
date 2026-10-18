import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Responder } from "../../checks/__fixtures__/harness.ts"
import { contextOf, optionsFor } from "../__fixtures__/api.ts"
import { selfIdentity } from "./self.ts"

/* An entity that is the caller: its read of itself is its test. */

const profile = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }
const doc = {
	info: { title: "me", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/me": {
			get: {
				operationId: "me.get",
				responses: { "200": { content: { "application/json": { schema: profile } }, description: "ok" } },
				"x-entity": { action: "read", identity: "self", name: "profile" },
			},
		},
	},
} as unknown as OpenApiDocument

const me: Responder = (_, path) =>
	path === "/openapi.json"
		? { body: doc, status: 200 }
		: path === "/me"
			? { body: { id: "u1", name: "a" }, status: 200 }
			: undefined

describe("selfIdentity", () => {
	it("reads the caller, and records the entity tested", async () => {
		for (const hooks of [{}, { resolveInput: async () => null }]) {
			const options = optionsFor(me, { hooks: hooks as never })
			const ctx = await contextOf(options)
			const entity = ctx.model.entities.get("profile")
			if (entity === undefined) throw new Error("no profile entity")
			await selfIdentity(ctx, entity)
			expect(options.seen.some((request) => request.path === "/me")).toBe(true)
			expect(ctx.state.entitiesTested).toEqual(["profile"])
		}
	})
})
