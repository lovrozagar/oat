import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model.ts"
import { noticePaths, publicReadPaths } from "./public.ts"
import type { Json } from "./types.ts"

const CTX = { entities: ENTITIES, shape: {} }

type Paths = Record<string, Record<string, Json & { responses: Json }>>

describe("noticePaths", () => {
	const paths = noticePaths(CTX) as Paths

	it("lists and reads notices, with no create", () => {
		expect(Object.keys(paths)).toEqual(["/v1/notices", "/v1/notices/{id}"])
		expect(Object.keys(paths["/v1/notices"] ?? {})).toEqual(["get"])
		expect(paths["/v1/notices"]?.get?.["x-entity"]).toEqual({ action: "list", identity: "id", name: "notice" })
		expect(paths["/v1/notices/{id}"]?.get?.["x-entity"]).toEqual({ action: "read", identity: "id", name: "notice" })
		expect(Object.keys(paths["/v1/notices/{id}"]?.get?.responses ?? {})).toEqual(["200", "404"])
	})
})

describe("publicReadPaths", () => {
	it("declares a health read that needs no token", () => {
		const health = (publicReadPaths(CTX) as Paths)["/health"]?.get
		expect(health).toMatchObject({ operationId: "gateway.health", security: [], tags: ["Gateway"] })
		expect(health).not.toHaveProperty("x-entity")
		const ranged = (publicReadPaths({ entities: ENTITIES, shape: { rangeStatuses: true } }) as Paths)["/health"]
		expect(Object.keys(ranged?.get?.responses ?? {})).toEqual(["2XX"])
	})
})
