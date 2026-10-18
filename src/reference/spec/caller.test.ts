import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
import { authTokenPaths, callerProfilePaths, callerRootPaths } from "./caller.ts"
import type { Json } from "./types.ts"

const CTX = { entities: ENTITIES, shape: {} }

type Paths = Record<string, Record<string, Json & { responses: Json }>>

describe("callerProfilePaths", () => {
	const paths = callerProfilePaths(CTX) as Paths

	it("reads and updates the caller as a record without an id", () => {
		expect(Object.keys(paths)).toEqual(["/v1/me"])
		expect(paths["/v1/me"]?.get).toMatchObject({
			operationId: "profile.get",
			"x-entity": { action: "read", identity: "self", name: "profile" },
		})
		expect(paths["/v1/me"]?.patch).toMatchObject({ operationId: "profile.update", "x-invalidate": ["GET /v1/me"] })
		expect(Object.keys(paths["/v1/me"]?.patch?.responses ?? {})).toEqual(["200", "400", "401"])
	})
})

describe("callerRootPaths", () => {
	const paths = callerRootPaths(CTX) as Paths

	it("routes a logout, the caller's project and a register", () => {
		expect(Object.keys(paths)).toEqual(["/v1/logout", "/v1/projects/{project_id}/overview", "/v1/register"])
	})

	it("marks the logout destructive and the register as minting a fresh principal", () => {
		expect(paths["/v1/logout"]?.post).toMatchObject({ operationId: "auth.logout", "x-destructive": true })
		expect(paths["/v1/register"]?.post).toMatchObject({ operationId: "auth.register", "x-fresh-principal": true })
		expect(Object.keys(paths["/v1/register"]?.post?.responses ?? {})).toEqual(["201"])
	})

	it("reads the caller's project as the root", () => {
		expect(paths["/v1/projects/{project_id}/overview"]?.get).toMatchObject({
			operationId: "project.overview",
			"x-entity": { action: "read", identity: "root", name: "overview" },
		})
	})
})

describe("authTokenPaths", () => {
	it("exchanges a key for a token without needing one", () => {
		const token = (authTokenPaths(CTX) as Paths)["/v1/auth/token"]?.post
		expect(token).toMatchObject({ operationId: "auth.token", security: [], tags: ["Auth"] })
		expect(Object.keys(token?.responses ?? {})).toEqual(["200", "400", "401", "415"])
		const ranged = (authTokenPaths({ entities: ENTITIES, shape: { rangeStatuses: true } }) as Paths)["/v1/auth/token"]
		expect(Object.keys(ranged?.post?.responses ?? {})).toEqual(["2XX", "default"])
	})
})
