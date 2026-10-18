import { describe, expect, it } from "vitest"
import { operation } from "./__fixtures__/operations.ts"
import { entityNamed, registerOperations } from "./entities.ts"
import type { EntityModel, OperationModel } from "./types.ts"

const invite = { accept: "POST /a", invite: "POST /i", revoke: "DELETE /i" } as unknown as OperationModel["invite"]

const register = (operations: OperationModel[]) => {
	const entities = new Map<string, EntityModel>()
	registerOperations(entities, operations)
	return entities
}

const note = (action: OperationModel["action"], operationId?: string, extra: Partial<OperationModel> = {}) =>
	operation({ action, entity: "note", ...(operationId === undefined ? {} : { operationId }), ...extra })

const identified = (identity: string | null, identitySource: OperationModel["identitySource"]) =>
	operation({ action: "read", entity: "note", identity, identitySource })

describe("registerOperations", () => {
	it("files each operation under its entity by action", () => {
		const entities = register([
			note("create", "invite.send", { invite }),
			note("create", "notes.create"),
			note("list", "notes.list"),
			note("read", "notes.get"),
			note("read", "notes.byName"),
			note("read", "notes.get"),
			note("update", "notes.update"),
			note("delete", "notes.delete"),
			note("action", "notes.pin"),
			note(null, "notes.orphan"),
			operation({ action: "read", entity: null, operationId: "ping" }),
		])
		expect([...entities.keys()]).toEqual(["note"])
		expect(entities.get("note")).toMatchObject({
			actions: ["notes.pin"],
			create: "notes.create",
			delete: "notes.delete",
			invite,
			list: "notes.list",
			read: "notes.get",
			reads: ["notes.get", "notes.byName"],
			update: "notes.update",
		})
	})

	it("takes the best-ranked identity: declared over the item route over the schema", () => {
		expect(register([identified("name", "schema"), identified("id", "route")]).get("note")?.identity).toBe("id")
		expect(register([identified("slug", "declared"), identified("id", "route")]).get("note")?.identity).toBe("slug")
		expect(register([identified(null, null), identified("name", "schema")]).get("note")?.identity).toBe("name")
	})

	it("collects tenancy once per parameter, and the create's unique sets over any other's", () => {
		const entities = register([
			note("list", undefined, { tenantParam: "org", unique: [["slug"]] }),
			note("read", undefined, { tenantParam: "org", unique: [["other"]] }),
			note("create", undefined, { tenantParam: "team", unique: [["name"]] }),
			note("update", undefined, { unique: [["late"]] }),
		])
		expect(entities.get("note")).toMatchObject({ tenantParams: ["org", "team"], unique: [["name"]] })
	})
})

describe("entityNamed", () => {
	it("creates an empty entity the first time, and returns it after", () => {
		const entities = new Map<string, EntityModel>()
		const first = entityNamed(entities, "note")
		expect(first).toEqual({
			actions: [],
			declaredSurface: [],
			identity: null,
			invite: null,
			name: "note",
			readSurface: [],
			tenantParams: [],
			trackable: false,
			unique: null,
		})
		expect(entityNamed(entities, "note")).toBe(first)
	})
})
