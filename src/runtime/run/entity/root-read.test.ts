import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../../../spec/types.ts"
import { contextOf, optionsFor } from "../__fixtures__/api.ts"
import { rootRead } from "./root-read.ts"

/* An entity whose path id is the caller's root: its read, with the root filled in, is its test. */

const org = { properties: { id: { type: "string" } }, type: "object" }
const doc = {
	info: { title: "orgs", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/orgs/{org_id}": {
			get: {
				operationId: "org.get",
				parameters: [{ in: "path", name: "org_id", required: true, schema: { type: "string" } }],
				responses: { "200": { content: { "application/json": { schema: org } }, description: "ok" } },
				"x-entity": { action: "read", identity: "root", name: "org" },
			},
		},
	},
} as unknown as OpenApiDocument

const orgs = (_: string, path: string) =>
	path === "/openapi.json"
		? { body: doc, status: 200 }
		: path === "/orgs/o1"
			? { body: { id: "o1" }, status: 200 }
			: undefined

describe("rootRead", () => {
	it("reads the root the first principal holds, and grades the read", async () => {
		const options = optionsFor(orgs, { roots: { org_id: "o1" } })
		const ctx = await contextOf(options)
		const entity = ctx.model.entities.get("org")
		if (entity === undefined) throw new Error("no org entity")
		await rootRead(ctx, entity)
		expect(options.seen.at(-1)).toMatchObject({ method: "GET", path: "/orgs/o1" })
		expect(ctx.state.entitiesTested).toEqual(["org"])
	})
})
