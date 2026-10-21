import { describe, expect, it } from "vitest"
import type { Recipe } from "../config/types/security.ts"
import type { AuthStep } from "../config/types/steps.ts"
import { recipeAnchors, revokeOperationId } from "./anchors.ts"

/* The operations a recipe issues, refreshes and revokes its credential through. */

/* Each step's operation: its operationId, or for a raw step the documented one at its path. */
const operationOf = (step: AuthStep): string | undefined =>
	"operationId" in step ? step.operationId : "path" in step && step.path === "/v1/auth/token" ? "auth.token" : undefined

const anchors = (recipe: Partial<Recipe>) => recipeAnchors(recipe, operationOf)

describe("recipeAnchors: login", () => {
	it("issues by the last step, refreshes by the refresh's, and revokes by the declared operation", () => {
		const recipe: Partial<Recipe> = {
			login: {
				from: "$.access_token",
				revoke: "auth.revoke",
				steps: [{ operationId: "auth.csrf" }, { operationId: "auth.login" }],
			},
			refresh: { from: "$.access_token", steps: [{ operationId: "auth.refresh" }] },
		}
		expect(anchors(recipe)).toEqual({
			issue: "auth.login",
			kind: "login",
			refresh: "auth.refresh",
			revoke: "auth.revoke",
		})
	})

	it("issues by the step that saved the scope key `from` names, and reads a revoke with a body", () => {
		const steps: [AuthStep, ...AuthStep[]] = [
			{ operationId: "auth.login", saveAs: { session: "$.sid" } },
			{ operationId: "auth.profile" },
		]
		const revoke = { body: { token: "{credential}" }, operationId: "auth.revoke" }
		expect(anchors({ login: { from: "session", revoke, steps } })).toEqual({
			issue: "auth.login",
			kind: "login",
			revoke: "auth.revoke",
		})
	})

	it("resolves a raw step by its documented operation, and leaves out one that resolves to none", () => {
		expect(anchors({ login: { from: "$.t", steps: [{ method: "POST", path: "/v1/auth/token" }] } })).toEqual({
			issue: "auth.token",
			kind: "login",
		})
		const otp: AuthStep = { outOfBand: { address: "a", as: "otp", kind: "otp" } }
		expect(anchors({ login: { from: "$.t", steps: [{ method: "POST", path: "/undocumented" }] } })).toEqual({
			kind: "login",
		})
		expect(anchors({ login: { from: "otp", steps: [{ operationId: "auth.start" }, otp] } })).toEqual({ kind: "login" })
	})
})

describe("recipeAnchors: the other kinds", () => {
	it("issues a mint by its operation and revokes it by its own, with neither when the mint declares no revoke", () => {
		const mint = { from: "$.key", operationId: "apiKey.create", revoke: "apiKey.revoke", with: "jwt" }
		expect(anchors({ mint })).toEqual({ issue: "apiKey.create", kind: "mint", revoke: "apiKey.revoke" })
		expect(anchors({ mint: { ...mint, revoke: undefined } as never })).toEqual({ issue: "apiKey.create", kind: "mint" })
	})

	it("names no operation for a static, hook or oauth2 credential, and nothing for a recipe of no kind", () => {
		expect(anchors({ static: "s" })).toEqual({ kind: "static" })
		expect(anchors({ hook: true })).toEqual({ kind: "hook" })
		expect(anchors({ oauth2: { clientId: "c", flow: "clientCredentials" } })).toEqual({ kind: "oauth2" })
		expect(anchors({ format: "{credential}" })).toBeUndefined()
	})
})

describe("recipeAnchors: what it exposes", () => {
	it("returns only kind, issue, refresh and revoke, each a string, and nothing of the recipe itself", () => {
		const recipe: Partial<Recipe> = {
			login: {
				from: "$.token",
				revoke: { body: { token: "{credential}" }, operationId: "auth.revoke" },
				steps: [{ body: { password: "{principal.password}" }, operationId: "auth.login" }],
			},
			refresh: { from: "$.token", steps: [{ body: { refresh_token: "{credential}" }, operationId: "auth.refresh" }] },
		}
		const found: object = anchors(recipe) ?? {}
		expect(Object.keys(found).sort()).toEqual(["issue", "kind", "refresh", "revoke"])
		expect(Object.values(found).every((value) => typeof value === "string")).toBe(true)
		expect(JSON.stringify(found)).not.toMatch(/password|credential|body|\$\./)
		expect(
			anchors({ mint: { from: "$.key", operationId: "k.create", revoke: { id: 1 } as never, with: "jwt" } }),
		).toEqual({
			issue: "k.create",
			kind: "mint",
		})
	})
})

describe("revokeOperationId", () => {
	it("reads a revoke named alone or with a body, and none", () => {
		expect([revokeOperationId("a"), revokeOperationId({ operationId: "b" }), revokeOperationId(undefined)]).toEqual([
			"a",
			"b",
			undefined,
		])
	})
})
