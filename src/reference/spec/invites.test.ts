import { describe, expect, it } from "vitest"
import { ENTITIES, TABLE } from "../model.ts"
import type { ReferenceShape } from "../shapes.ts"
import { invitePaths } from "./invites.ts"
import type { Json } from "./types.ts"

function paths(shape: ReferenceShape): Record<string, Record<string, Json & { responses: Json }>> {
	return invitePaths({ entities: ENTITIES, shape }, TABLE) as never
}

describe("invitePaths", () => {
	const declared = paths({})

	it("routes an invite, its acceptance and the grant's revocation", () => {
		expect(Object.keys(declared)).toEqual([
			`${TABLE.itemPath}/invites`,
			"/v1/invites/{token}/accept",
			`${TABLE.itemPath}/grants/{grant_id}`,
		])
	})

	it("ties the three operations together with x-invite", () => {
		const invite = declared[`${TABLE.itemPath}/invites`]?.post
		expect(invite).toMatchObject({
			operationId: "table.invite",
			"x-entity": { action: "action", identity: "id", name: "table" },
			"x-invite": { accept: "invite.accept", invite: "table.invite", revoke: "table.revoke" },
			"x-tenant": "project_id",
		})
		expect(Object.keys(invite?.responses ?? {})).toEqual(["201", "400", "401", "403", "404", "415"])
	})

	it("accepts by token alone, and revokes by grant on the table", () => {
		const accept = declared["/v1/invites/{token}/accept"]?.post
		expect(accept?.parameters).toEqual([{ in: "path", name: "token", required: true, schema: { type: "string" } }])
		expect(accept).not.toHaveProperty("x-tenant")
		const revoke = declared[`${TABLE.itemPath}/grants/{grant_id}`]?.delete
		expect(((revoke?.parameters ?? []) as Json[]).map((param) => param.name)).toEqual([
			"project_id",
			"table_id",
			"grant_id",
		])
		expect(Object.keys(revoke?.responses ?? {})).toEqual(["200", "400", "401", "403", "404"])
	})

	it("names the table by its slug under the slug key", () => {
		const slugged = paths({ tableKey: "slug" })
		expect(slugged["/v1/invites/{token}/accept"]?.post?.["x-entity"]).toHaveProperty("identity", "slug")
	})
})
