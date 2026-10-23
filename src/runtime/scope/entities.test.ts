import { describe, expect, it } from "vitest"
import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"
import type { OperationModel } from "../../spec/graph/types.ts"
import { entityOf, referenceModel } from "./__fixtures__/models.ts"
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

	it("never makes an entity lane of one whose read, update, delete or list a recipe names", () => {
		expect(untestableEntityReason(row, model, new Set(["row.delete"]))).toBe(
			'"row" holds credentials: a security recipe calls row.delete, so no check may',
		)
		expect(untestableEntityReason(row, model, new Set(["row.get", "row.list"]))).toMatch(/recipe calls row\.list/)
		expect(untestableEntityReason(row, model, new Set(["row.create"]))).toBeNull()
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
			"job",
			"notice",
			"overview",
			"profile",
			"row",
			"table",
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
