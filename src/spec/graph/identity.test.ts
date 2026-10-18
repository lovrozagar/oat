import { describe, expect, it } from "vitest"
import { member } from "../__fixtures__/documents.ts"
import { identityRank, operationIdentity } from "./identity.ts"

describe("operationIdentity", () => {
	it("takes a declared identity first", () => {
		expect(operationIdentity("slug", member, "/notes/{id}", ["id"])).toEqual({
			identity: "slug",
			identitySource: "declared",
		})
	})

	it("reads the identity off the item route's parameter, camelCase or snake_case", () => {
		expect(operationIdentity(undefined, null, "/tables/{tableId}", ["tableId"])).toEqual({
			identity: "id",
			identitySource: "route",
		})
		expect(operationIdentity(undefined, null, "/tables/{table_id}", ["table_id"]).identity).toBe("id")
		expect(operationIdentity(undefined, null, "/w/{workspaceUuid}", ["workspaceUuid"]).identity).toBe("uuid")
	})

	/* Teardown deletes by the identity through the item route, so the property the route's own
	 * parameter names wins over a required display field: deleting `/notes/{name}` reads as a 404,
	 * which counts as removed, and the real record stays behind. */
	it("prefers the property the item route's parameter names over a required name", () => {
		const note = {
			properties: { id: { readOnly: true, type: "string" }, name: { type: "string" } },
			required: ["name"],
			type: "object",
		}
		expect(operationIdentity(undefined, note, "/notes/{noteId}", ["noteId"]).identity).toBe("id")
		expect(operationIdentity(undefined, note, "/notes/{note_id}", ["note_id"]).identity).toBe("id")
		expect(operationIdentity(undefined, note, "/notes", [])).toEqual({ identity: "name", identitySource: "schema" })
		const page = {
			properties: { id: { type: "string" }, slug: { type: "string" } },
			required: ["id", "slug"],
			type: "object",
		}
		expect(operationIdentity(undefined, page, "/pages/{pageSlug}", ["pageSlug"]).identity).toBe("slug")
		expect(operationIdentity(undefined, page, "/pages/{pageRef}", ["pageRef"]).identity).toBe("id")
	})

	it("reads the schema alone on a collection route, and has none when nothing names one", () => {
		expect(operationIdentity(undefined, { anyOf: [{ type: "null" }, member] }, "/p/{p}/notes", ["p"])).toEqual({
			identity: "id",
			identitySource: "schema",
		})
		expect(operationIdentity(undefined, { type: "object" }, "/notes", [])).toEqual({
			identity: null,
			identitySource: null,
		})
	})
})

describe("identityRank", () => {
	it("ranks a declared identity over a route's, over a schema's", () => {
		expect(["declared", "route", "schema", null].map((source) => identityRank(source as never))).toEqual([2, 1, 0, 0])
	})
})
