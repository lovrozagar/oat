import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import { dereference } from "../../spec/load/dereference.ts"
import { bearerSecurity } from "../harness/security.ts"
import { widgetSpec } from "./spec.ts"

type Operation = Record<string, unknown>

function operations(options: Parameters<typeof widgetSpec>[0]): { create: Operation; update: Operation } {
	const paths = widgetSpec(options).paths as Record<string, Record<string, Operation>>
	return {
		create: paths["/v1/orgs/{org_id}/widgets"]?.post ?? {},
		update: paths["/v1/orgs/{org_id}/widgets/{widget_id}"]?.patch ?? {},
	}
}

describe("widgetSpec", () => {
	it("tags both writes [name] by default, and builds into one widget entity", () => {
		const { create, update } = operations(undefined)
		expect(create["x-unique"]).toEqual([["name"]])
		expect(update["x-unique"]).toEqual([["name"]])
		expect(create["x-generated"]).toEqual(["id"])
		expect(create["x-feature-gate"]).toBeUndefined()
		expect(update["x-immutable"]).toEqual([])
		expect(buildModel(widgetSpec()).entities.get("widget")?.unique).toEqual([["name"]])
	})

	it("carries the tag, the gate and the idempotency header as asked, or no tag at all", () => {
		const { create, update } = operations({ featureGate: "widgets", idempotencyRequired: true, tag: [["email"]] })
		expect(create["x-unique"]).toEqual([["email"]])
		expect(update["x-feature-gate"]).toBe("widgets")
		expect((create.parameters as Array<{ required: boolean }>)[1]?.required).toBe(true)
		expect(operations({ omitTag: true }).create).not.toHaveProperty("x-unique")
	})

	it("types an update field the create body does not know as a string", () => {
		const { update } = operations({ immutable: ["workspace_id"], updateBody: ["workspace_id", "name"] })
		const body = update.requestBody as { content: Record<string, { schema: { properties: unknown } }> }
		expect(body.content["application/json"]?.schema.properties).toEqual({
			name: { maxLength: 128, type: "string" },
			workspace_id: { type: "string" },
		})
		expect(update["x-immutable"]).toEqual(["workspace_id"])
	})
})

describe("widgetSpec security", () => {
	it("requires the bearer on every operation, from the root", () => {
		const doc = widgetSpec()
		expect(doc).toMatchObject(bearerSecurity())
		const sources = buildModel(dereference(doc).doc).operations.map((op) => op.security.source)
		expect(new Set(sources)).toEqual(new Set(["root"]))
	})
})
