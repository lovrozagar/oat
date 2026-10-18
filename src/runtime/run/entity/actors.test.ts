import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Principal } from "../../../config/types/principals.ts"
import { contextOf, entityRunOf, notesApi, optionsFor } from "../__fixtures__/api.ts"
import { actorsOf, isolationOf } from "./actors.ts"
import type { World } from "./state.ts"

/*
 * Every principal as the checks act as it: the first in the entity's world, the others each in a
 * scope of their own; the first of another tenant is the one isolation checks cross into.
 */

const world: World = {
	createAcknowledged: false,
	degraded: false,
	records: [],
	scope: { created: [], values: { w: "1" } },
	uniqueAdopted: false,
}

const member = (id: string, org: string, extra: Partial<Principal> = {}): Principal => ({
	headers: { authorization: `Bearer ${id}-key` },
	id,
	roots: { org_id: org },
	...extra,
})

/** Cards listed under a board nobody can create. */
const boardless = {
	info: { title: "cards", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/boards/{board_id}/cards": {
			get: {
				operationId: "cards.list",
				parameters: [{ in: "path", name: "board_id", required: true, schema: { type: "string" } }],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { items: { properties: { id: { type: "string" } }, type: "object" }, type: "array" },
							},
						},
						description: "ok",
					},
				},
			},
		},
	},
} as unknown as OpenApiDocument

const servingBoardless = (_: string, path: string) =>
	path === "/openapi.json" ? { body: boardless, status: 200 } : undefined

describe("actorsOf", () => {
	it("acts as the first principal in the world, and as each other in a scope of its own", async () => {
		const ctx = await contextOf(
			optionsFor(notesApi(), {
				principals: [member("alpha", "o1"), member("beta", "o2", { inviteAs: "b@x", rank: 1, role: "member" })],
			}),
		)
		const actors = await actorsOf(entityRunOf(ctx), world)
		expect(actors.map((actor) => [actor.id, actor.scope])).toEqual([
			["alpha", { w: "1" }],
			["beta", { org_id: "o2" }],
		])
		expect(actors[1]).toMatchObject({ inviteAs: "b@x", rank: 1, role: "member", roots: { org_id: "o2" } })
		expect(isolationOf(actors)?.id).toBe("beta")
	})

	it("leaves a principal in its roots alone when its scope cannot be made", async () => {
		const ctx = await contextOf(
			optionsFor(servingBoardless, { principals: [member("alpha", "o1"), member("beta", "o2")] }),
		)
		const actors = await actorsOf(entityRunOf(ctx, "card"), world)
		expect(actors[1]?.scope).toEqual({ org_id: "o2" })
	})
})

describe("isolationOf", () => {
	it("finds no other tenant among principals of one", async () => {
		const ctx = await contextOf(optionsFor(notesApi(), { principals: [member("alpha", "o1"), member("admin", "o1")] }))
		expect(isolationOf(await actorsOf(entityRunOf(ctx), world))).toBeUndefined()
	})
})
