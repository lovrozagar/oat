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

	it("routes a logout, the caller's account, the caller's project and a register", () => {
		expect(Object.keys(paths)).toEqual([
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

	it("reads the caller's project as the root", () => {
		expect(paths["/v1/projects/{project_id}/overview"]?.["get"]).toMatchObject({
			operationId: "project.overview",
			"x-entity": { action: "read", identity: "root", name: "overview" },
		})
	})
})
