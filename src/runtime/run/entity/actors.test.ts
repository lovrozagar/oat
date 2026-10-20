import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { PrincipalEntry } from "../../../config/types/security.ts"
import { contextOf, entityRunOf, notesApi, optionsFor } from "../__fixtures__/api.ts"
import { actorsOf, peerOf } from "./actors.ts"
import type { World } from "./state.ts"

/*
 * Every principal as the checks act as it: the first in the entity's world, the others each in a
 * scope of their own; the first of another tenant is the peer the isolation checks cross into.
 */

const world: World = {
	createAcknowledged: false,
	degraded: false,
	records: [],
	scope: { created: [], values: { w: "1" } },
	uniqueAdopted: false,
}

/** A principal of tenant `org`, its records under that org. */
const member = (org: string, extra: PrincipalEntry = {}): PrincipalEntry => ({
	scope: { org_id: org },
	tenant: org,
	...extra,
})

/** Cards listed under a board nobody can create. */
const boardless = {
	components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
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
				principals: { alpha: member("o1"), beta: member("o2", { inviteAs: "b@x", rank: 1 }) },
			}),
		)
		const actors = await actorsOf(entityRunOf(ctx), world)
		expect(actors.map((actor) => [actor.id, actor.scope])).toEqual([
			["alpha", { w: "1" }],
			["beta", { org_id: "o2" }],
		])
		expect(actors[1]).toEqual({ id: "beta", inviteAs: "b@x", rank: 1, scope: { org_id: "o2" }, tenant: "o2" })
		expect(peerOf(actors)?.id).toBe("beta")
	})

	it("leaves a principal in its own scope alone when its parents cannot be made", async () => {
		const ctx = await contextOf(
			optionsFor(servingBoardless, { principals: { alpha: member("o1"), beta: member("o2") } }),
		)
		const actors = await actorsOf(entityRunOf(ctx, "card"), world)
		expect(actors[1]?.scope).toEqual({ org_id: "o2" })
	})
})

describe("peerOf", () => {
	it("finds no other tenant among principals of one", async () => {
		const ctx = await contextOf(optionsFor(notesApi(), { principals: { admin: member("o1"), alpha: member("o1") } }))
		expect(peerOf(await actorsOf(entityRunOf(ctx), world))).toBeUndefined()
	})
})
