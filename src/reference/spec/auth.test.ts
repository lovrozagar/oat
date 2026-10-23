import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
import { authPaths } from "./auth.ts"
import type { Json } from "./types.ts"

const CTX = { entities: ENTITIES, shape: {} }

type Paths = Record<string, Record<string, Json & { responses: Json }>>

const paths = authPaths(CTX) as Paths
const op = (path: string, method: string) => paths[path]?.[method] as Json & { responses: Json }
const statuses = (path: string, method: string) => Object.keys(op(path, method).responses)
const bodyOf = (path: string, method: string) =>
	(op(path, method)["requestBody"] as { content: Record<string, { schema: Json }> }).content["application/json"]?.schema

describe("authPaths", () => {
	it("routes the token, login, refresh and revoke operations, then minting, reading and revoking API keys", () => {
		expect(Object.keys(paths)).toEqual([
			"/v1/auth/token",
			"/v1/auth/login",
			"/v1/auth/refresh",
			"/v1/auth/revoke",
			"/v1/api-keys",
			"/v1/api-keys/{id}",
		])
		expect(
			Object.entries(paths).flatMap(([, item]) => Object.values(item).map((operation) => operation["operationId"])),
		).toEqual([
			"auth.token",
			"auth.login",
			"auth.refresh",
			"auth.revoke",
			"apiKey.create",
			"apiKey.revoke",
			"apiKey.get",
		])
	})

	it("declares the sign-ins public, with the session they answer and the throttle's 429", () => {
		for (const path of ["/v1/auth/token", "/v1/auth/login"]) {
			expect(op(path, "post")).toMatchObject({ security: [], tags: ["Auth"] })
			expect(statuses(path, "post")).toEqual(["200", "400", "401", "415", "429"])
			expect(op(path, "post").responses["429"]).toHaveProperty("headers.Retry-After.schema", { type: "integer" })
		}
		expect(op("/v1/auth/refresh", "post")["security"]).toEqual([])
		const session = op("/v1/auth/token", "post").responses["200"] as Json
		expect(session).toHaveProperty("content.application/json.schema.required", [
			"access_token",
			"refresh_token",
			"expires_in",
			"project_id",
		])
		expect(bodyOf("/v1/auth/login", "post")).toMatchObject({ required: ["email", "password"] })
		expect(bodyOf("/v1/auth/refresh", "post")).toMatchObject({ required: ["refresh_token"] })
	})

	it("spells every status as a range and a default under rangeStatuses", () => {
		const ranged = authPaths({ entities: ENTITIES, shape: { rangeStatuses: true } }) as Paths
		expect(Object.keys(ranged["/v1/auth/login"]?.["post"]?.responses ?? {})).toEqual(["429", "2XX", "default"])
		expect(Object.keys(ranged["/v1/api-keys/{id}"]?.["delete"]?.responses ?? {})).toEqual(["2XX", "default"])
	})
})

describe("the API key operations", () => {
	it("leaves revoking a token and the API key operations under the root jwt alone", () => {
		for (const [path, method] of [
			["/v1/auth/revoke", "post"],
			["/v1/api-keys", "post"],
			["/v1/api-keys/{id}", "delete"],
			["/v1/api-keys/{id}", "get"],
		] as const) {
			expect(op(path, method)).not.toHaveProperty("security")
		}
		expect(statuses("/v1/api-keys", "post")).toEqual(["201", "400", "401", "415"])
		expect(statuses("/v1/api-keys/{id}", "delete")).toEqual(["200", "401", "404"])
		expect(statuses("/v1/api-keys/{id}", "get")).toEqual(["200", "401", "404"])
		expect(bodyOf("/v1/api-keys", "post")).toMatchObject({
			properties: {
				scopes: { items: { enum: ["table:read", "table:write", "row:read", "row:write", "job:read", "job:write"] } },
			},
		})
	})

	it("name the key's read as what minting and revoking it change", () => {
		for (const [path, method] of [
			["/v1/api-keys", "post"],
			["/v1/api-keys/{id}", "delete"],
		] as const)
			expect(op(path, method)["x-invalidate"]).toEqual(["GET /v1/api-keys/{id}"])
	})
})
