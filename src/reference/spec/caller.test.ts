import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
import { PHONE_PATTERN, STRING_GUARD } from "../model/string-guard.ts"
import { callerProfilePaths, callerRootPaths } from "./caller.ts"
import type { Json } from "./types.ts"

const CTX = { entities: ENTITIES, shape: {} }

type Paths = Record<string, Record<string, Json & { responses: Json }>>

describe("callerProfilePaths", () => {
	const paths = callerProfilePaths(CTX) as Paths

	it("reads and updates the caller as a record without an id", () => {
		expect(Object.keys(paths)).toEqual(["/v1/me"])
		expect(paths["/v1/me"]?.["get"]).toMatchObject({
			operationId: "profile.get",
			"x-entity": { action: "read", identity: "self", name: "profile" },
		})
		expect(paths["/v1/me"]?.["patch"]).toMatchObject({ operationId: "profile.update", "x-invalidate": ["GET /v1/me"] })
		expect(Object.keys(paths["/v1/me"]?.["patch"]?.responses ?? {})).toEqual(["200", "400", "401"])
	})
})

describe("callerRootPaths", () => {
	const paths = callerRootPaths(CTX) as Paths

	it("routes the listing of sign-ups, an admin's account delete, a logout, the caller's account, the caller's project and a register", () => {
		expect(Object.keys(paths)).toEqual([
			"/v1/signups",
			"/v1/signups/{account_id}",
			"/v1/logout",
			"/v1/me/account",
			"/v1/projects/{project_id}/overview",
			"/v1/register",
		])
	})

	it("updates the caller's account, untagged, with the email and password it signs in by", () => {
		const update = paths["/v1/me/account"]?.["put"] as Json & { requestBody: Json; responses: Json }
		expect(update).toMatchObject({ operationId: "account.update" })
		expect(Object.keys(update).filter((key) => key.startsWith("x-"))).toEqual([])
		expect(JSON.stringify(update.requestBody)).toContain('"password":{"minLength":8,"type":"string"}')
		expect(Object.keys(update.responses)).toEqual(["200", "400", "401"])
	})

	it("marks the logout destructive, and the register public and minting a fresh principal", () => {
		expect(paths["/v1/logout"]?.["post"]).toMatchObject({ operationId: "auth.logout", "x-destructive": true })
		expect(paths["/v1/register"]?.["post"]).toMatchObject({
			operationId: "auth.register",
			security: [],
			"x-fresh-principal": true,
		})
		expect(paths["/v1/logout"]?.["post"]).not.toHaveProperty("security")
		expect(Object.keys(paths["/v1/register"]?.["post"]?.responses ?? {})).toEqual(["201"])
	})

	it("marks the register's staff flag x-privileged, and lists each sign-up with it", () => {
		expect(JSON.stringify(paths["/v1/register"]?.["post"])).toContain('"staff":{"type":"boolean","x-privileged":true}')
		const list = paths["/v1/signups"]?.["get"] as Json & { responses: Record<string, Json> }
		expect(list).toMatchObject({
			operationId: "signup.list",
			"x-entity": { action: "list", identity: "account_id", name: "signup" },
		})
		expect(list).not.toHaveProperty("security")
		expect(paths["/v1/register"]?.["post"]).toMatchObject({ "x-invalidate": ["GET /v1/signups"] })
		expect(paths["/v1/signups/{account_id}"]?.["delete"]).toMatchObject({ "x-invalidate": ["GET /v1/signups"] })
		expect(Object.keys(list.responses)).toEqual(["200", "401"])
		expect(JSON.stringify(list.responses)).toContain(
			'"signups":{"items":{"additionalProperties":false,"properties":{"account_id":{"type":"string"},' +
				'"email":{"type":"string"},"staff":{"type":"boolean"}},"required":["account_id","email","staff"],' +
				'"type":"object"},"type":"array"}',
		)
	})

	it("reads the caller's project as the root", () => {
		expect(paths["/v1/projects/{project_id}/overview"]?.["get"]).toMatchObject({
			operationId: "project.overview",
			"x-entity": { action: "read", identity: "root", name: "overview" },
		})
	})
})

describe("callerProfilePaths under the string guard", () => {
	it("guards first_name and adds a nullable phone_number whose own pattern sits beside the guard in an allOf", () => {
		const paths = callerProfilePaths({ entities: ENTITIES, shape: { stringGuard: true } }) as Paths
		const body = paths["/v1/me"]?.["patch"] as Json
		expect(body).toMatchObject({
			requestBody: {
				content: {
					"application/json": {
						schema: {
							properties: {
								first_name: { maxLength: 64, pattern: STRING_GUARD, type: "string" },
								phone_number: {
									anyOf: [
										{
											allOf: [{ pattern: PHONE_PATTERN }, { pattern: STRING_GUARD }],
											maxLength: 15,
											minLength: 7,
											type: "string",
										},
										{ type: "null" },
									],
								},
							},
						},
					},
				},
			},
		})
	})
})

describe("callerProfilePaths under the totp-setup shape", () => {
	it("documents the TOTP setup, outside any entity, so the contract floor calls it", () => {
		const paths = callerProfilePaths({ entities: ENTITIES, shape: { totpSetup: true } }) as Paths
		const setup = paths["/v1/me/2fa"]?.["post"] as Json & { responses: Json }
		expect(setup).toMatchObject({ operationId: "auth.setup2fa" })
		expect(setup["x-entity"]).toBeUndefined()
		expect(Object.keys(setup.responses)).toEqual(["200", "401"])
		expect(callerProfilePaths(CTX)).not.toHaveProperty("/v1/me/2fa")
	})
})
