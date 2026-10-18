import { describe, expect, it } from "vitest"
import { deriveIdentity } from "./identity.ts"

const schema = (names: string[], required: unknown = []) => ({
	properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])),
	required,
	type: "object",
})

describe("deriveIdentity", () => {
	it("takes the property the item route's parameter names, when the schema has it", () => {
		expect(deriveIdentity(schema(["id", "name"], ["name"]), "noteId")).toBe("id")
		expect(deriveIdentity(schema(["slug", "id"], ["id"]), "table_slug")).toBe("slug")
		expect(deriveIdentity(schema(["uuid"]), "note.uuid")).toBe("uuid")
	})

	it("prefers a required identity-like property on a parent's route", () => {
		expect(deriveIdentity(schema(["id", "name"], ["name"]), "noteId", false)).toBe("name")
	})

	it("falls back to a required, then any, identity-like property", () => {
		expect(deriveIdentity(schema(["key", "slug"], ["slug"]))).toBe("slug")
		expect(deriveIdentity(schema(["key", "slug"], "slug"))).toBe("slug")
		expect(deriveIdentity(schema(["title", "key"]), "projectRef")).toBe("key")
	})

	it("falls back to the parameter's implied name, else null", () => {
		expect(deriveIdentity(schema(["title"]), "noteId")).toBe("id")
		expect(deriveIdentity(null, "note_id")).toBe("id")
		expect(deriveIdentity({ properties: null }, "id")).toBe("id")
		expect(deriveIdentity({ allOf: [schema(["title"])] }, "ref")).toBeNull()
		expect(deriveIdentity(schema(["title"]))).toBeNull()
	})
})
