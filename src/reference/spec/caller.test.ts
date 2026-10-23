import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
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
