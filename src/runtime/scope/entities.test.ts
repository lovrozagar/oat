import { describe, expect, it } from "vitest"
import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { entityOf, keyModel, referenceModel } from "./__fixtures__/models.ts"
import {
	authStepOperationIds,
	createIsAuthProvisioned,
	staticSubjects,
	testableEntities,
	untestableEntityReason,
	untestableReason,
} from "./entities.ts"

const model = referenceModel()

/* The entity without the given operations, as a document that lacks them would model it. */
const omit = <T extends object>(value: T, ...keys: Array<keyof T>): T =>
	Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as keyof T))) as T
const none = new Set<string>()

describe("staticSubjects", () => {
	it("derives subjects statically from the entity graph", () => {
		expect([...staticSubjects(entityOf(model, "table"), model)].sort()).toEqual([
			"invite.accept",
			"table.create",
			"table.delete",
			"table.get",
			"table.invite",
			"table.list",
			"table.revoke",
			"table.update",
		])
		const rowSubjects = staticSubjects(entityOf(model, "row"), model)
		expect(rowSubjects.has("table.get")).toBe(true)
		expect(rowSubjects.has("table.list")).toBe(true)
		expect(rowSubjects.has("table.create")).toBe(false)
		expect(staticSubjects(entityOf(model, "job"), model).has("job.start")).toBe(true)
	})
})

describe("authStepOperationIds", () => {
	it("names the operations a recipe's login and refresh steps send, a principal's own overrides among them", () => {
		const security: SecurityConfig = {
			jwt: {
				login: {
					from: "$.token",
					steps: [
						{ body: {}, operationId: "auth.register" },
						{ method: "GET", path: "/consume" },
					],
				},
				refresh: { from: "$.token", steps: [{ operationId: "auth.refresh" }] },
			},
			key: { mint: { from: "$.key", operationId: "keys.create", with: "jwt" } },
			plain: { static: "s" },
		}
		const principals: PrincipalsConfig = {
			alpha: {},
			beta: { security: { jwt: { login: { from: "$.t", steps: [{ operationId: "auth.otp" }] } } } },
			gamma: { security: { plain: { holds: ["a"] } } },
		}
		expect([...authStepOperationIds({ principals, security })]).toEqual([
			"auth.register",
			"auth.refresh",
			"keys.create",
			"auth.otp",
		])
		expect([...authStepOperationIds({})]).toEqual([])
	})

	it("names every operation a recipe names: a mint's and its revoke, and a login's revoke", () => {
		const security: SecurityConfig = {
			jwt: {
				login: {
					from: "$.token",
					revoke: { body: {}, operationId: "auth.revoke" },
					steps: [{ operationId: "auth.token" }],
				},
			},
			key: { mint: { from: "$.key", operationId: "apiKey.create", revoke: "apiKey.revoke", with: "jwt" } },
		}
		expect([...authStepOperationIds({ security })]).toEqual([
			"auth.token",
			"auth.revoke",
			"apiKey.create",
			"apiKey.revoke",
		])
	})
})

describe("createIsAuthProvisioned", () => {
	it("is a create that signs up a principal, or one an auth step already ran", () => {
		const create = model.byOperationId.get("row.create") as OperationModel
		expect(createIsAuthProvisioned(model.byOperationId.get("auth.register") as OperationModel, none)).toBe(true)
		expect(createIsAuthProvisioned(create, new Set(["row.create"]))).toBe(true)
		expect(createIsAuthProvisioned(create, none)).toBe(false)
	})
})

describe("untestableEntityReason", () => {
	const row = entityOf(model, "row")

	it("tests an entity with a cohort, an invite, a caller identity, a root identity, effects, or a list alone", () => {
		for (const name of ["table", "row", "job", "profile", "notice", "overview"]) {
			expect(untestableEntityReason(entityOf(model, name), model, none)).toBeNull()
		}
	})

	it("does not test an entity the auth flow creates with no item route", () => {
		expect(untestableEntityReason(omit(row, "read"), model, new Set(["row.create"]))).toBe(
			'"row" is created by the auth flow and has no item route',
		)
		expect(untestableEntityReason({ ...omit(row, "read"), create: "auth.register" }, model, none)).toBe(
			'"row" is created by the auth flow and has no item route',
		)
	})

	it("tests an entity whose read, update, delete or list a recipe names: the guard keeps its credential records", () => {
		expect(untestableEntityReason(row, model, new Set(["row.delete"]))).toBeNull()
		expect(untestableEntityReason(row, model, new Set(["row.get", "row.list"]))).toBeNull()
		expect(untestableEntityReason(row, model, new Set(["row.create"]))).toBeNull()
	})
})

/* A create's 201 answer: a JSON object of these properties. */
const json = (properties: Record<string, unknown>) => ({
	content: { "application/json": { schema: { properties, type: "object" } } },
	description: "made",
})

describe("untestableEntityReason and where a mint's answer names the record", () => {
	const mints = Object.assign(new Set(["key.create", "key.delete"]), { mints: new Set(["key.create"]) })
	const reason = (keys: ReturnType<typeof keyModel>, identity?: null) => {
		const key = entityOf(keys, "key")
		return untestableEntityReason(identity === null ? { ...key, identity } : key, keys, mints)
	}
	const blind =
		'"key" holds credentials a security recipe mints with key.create, whose answer names no id to protect them by, so no check may'

	it("keeps out a key whose mint answers no id, under the record path it declares or none", () => {
		expect(reason(keyModel(json({ key: { type: "string" } })))).toBe(blind)
		expect(reason(keyModel())).toBe(blind)
		expect(reason(keyModel(json({ key: { type: "string" } }), { recordPath: "$.data" }))).toBe(blind)
	})

	it("takes the id from a declared source, a Location, the wrapped record, or the default identity", () => {
		expect(reason(keyModel(json({ key: { type: "string" } }), { createdIdFrom: "$.handle" }))).toBeNull()
		const located = { ...json({ key: { type: "string" } }), headers: { Location: { schema: { type: "string" } } } }
		expect(reason(keyModel(located))).toBeNull()
		const wrapped = json({ data: { properties: { id: { type: "string" } }, type: "object" } })
		expect(reason(keyModel(wrapped, { recordPath: "$.data" }))).toBeNull()
		expect(reason(keyModel(json({ id: { type: "string" } })), null)).toBeNull()
	})
})

describe("untestableEntityReason and credentials", () => {
	const row = entityOf(model, "row")

	it("tests the reference's minted keys, whose mint answers each key's id, and keeps out one whose mint names none", () => {
		const keys = authStepOperationIds({
			security: {
				apiKey: { mint: { from: "$.key", operationId: "apiKey.create", revoke: "apiKey.revoke", with: "jwt" } },
			},
		})
		expect(untestableEntityReason(entityOf(model, "api-key"), model, keys)).toBeNull()
		/* A mint makes credentials, not an account: the lanes may send it for records of their own. */
		expect(createIsAuthProvisioned(model.byOperationId.get("apiKey.create") as OperationModel, keys)).toBe(false)
		/* A mint that answers no id and no Location leaves nothing to protect the credential by. */
		const blind = { ...row, create: "auth.revoke" }
		expect(untestableEntityReason(blind, model, new Set(["auth.revoke", "row.delete"]))).toBe(
			'"row" holds credentials a security recipe mints with auth.revoke, whose answer names no id to protect them by, so no check may',
		)
	})

	it("names what a cohort is missing", () => {
		expect(untestableEntityReason({ ...row, trackable: false }, model, none)).toBe(
			'"row" has no records oat can identify after create',
		)
		expect(untestableEntityReason(omit(row, "create", "list"), model, none)).toBe(
			'"row" has no list operation and no create operation',
		)
		const profile = entityOf(model, "profile")
		expect(untestableEntityReason(omit(profile, "read", "update"), model, none)).toBe(
			'"profile" has no list operation and no create operation',
		)
		const overview = entityOf(model, "overview")
		expect(untestableEntityReason(omit(overview, "read"), model, none)).toMatch(/has no list operation/)
		const table = entityOf(model, "table")
		expect(untestableEntityReason({ ...omit(table, "create", "list"), invite: null }, model, none)).toMatch(
			/has no list operation/,
		)
	})

	it("lists only the entities it can test, by name", () => {
		expect(testableEntities(model, none).map((entity) => entity.name)).toEqual([
			"api-key",
			"job",
			"notice",
			"overview",
			"profile",
			"row",
			"table",
			"webhook",
		])
	})
})

describe("untestableReason", () => {
	it("says no entity owns it, its entity cannot be tested, or no check judges it", () => {
		expect(untestableReason(model.byOperationId.get("auth.token") as OperationModel, model, none)).toBe(
			"unmodeled: no entity owns POST /v1/auth/token",
		)
		expect(
			untestableReason(model.byOperationId.get("row.create") as OperationModel, model, new Set(["row.create"])),
		).toBe("no-applicable-check: no check judges row.create")
		/* Rows whose records oat cannot identify after a create. */
		const row = { ...entityOf(model, "row"), trackable: false }
		const untrackable = { ...model, entities: new Map([...model.entities, ["row", row]]) }
		expect(untestableReason(model.byOperationId.get("row.create") as OperationModel, untrackable, none)).toBe(
			'entity-not-testable: "row" has no records oat can identify after create',
		)
	})
})

describe("untestableEntityReason for an entity with no list", () => {
	const row = entityOf(model, "row")

	it("tests an entity with a create, an item read and an identity but no list: its creates are its cohort", () => {
		expect(untestableEntityReason(omit(row, "list"), model, none)).toBeNull()
	})

	it("names what an entity with no list lacks to be found again by its item read", () => {
		expect(untestableEntityReason(omit(row, "list", "read", "reads"), model, none)).toBe(
			'"row" has no list operation and no read operation',
		)
		expect(untestableEntityReason({ ...omit(row, "list"), trackable: false }, model, none)).toBe(
			'"row" has no records oat can identify after create',
		)
		expect(untestableEntityReason(omit(row, "list"), model, new Set(["row.create"]))).toBe(
			'"row" has no list operation and no create other than the sign-up the auth flow sends',
		)
	})
})
