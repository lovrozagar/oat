import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
import { shapedEntities } from "../model/shaped.ts"
import { TABLE } from "../model/table.ts"
import { components } from "./components.ts"
import { paymentSchemas } from "./query-route.ts"
import { itemSchema } from "./schemas.ts"

describe("components", () => {
	it("declares the error schemas, the shared Point, recursive TreeNode, the payment branches, and the jwt and apiKey schemes", () => {
		const declared = components({ entities: ENTITIES, shape: {} }) as {
			schemas: Record<string, unknown>
			securitySchemes: unknown
		}
		expect(Object.keys(declared.schemas).slice(-6)).toEqual(["Error", "Problem", "Point", "TreeNode", "Card", "Bank"])
		expect(declared.schemas["Card"]).toEqual(paymentSchemas().Card)
		expect(declared.schemas["TreeNode"]).toHaveProperty("properties.children.items", {
			$ref: "#/components/schemas/TreeNode",
		})
		expect(Object.keys(declared.securitySchemes as object)).toEqual(["apiKey", "jwt"])
		expect(declared).toHaveProperty("securitySchemes.jwt", { bearerFormat: "JWT", scheme: "bearer", type: "http" })
	})

	it("declares each entity's record schema under the layout shape", () => {
		const shape = { specLayout: true }
		const entities = shapedEntities(shape)
		const declared = components({ entities, shape }) as { schemas: Record<string, unknown> }
		expect(Object.keys(declared.schemas).slice(-4)).toEqual(["Table", "Row", "Job", "Webhook"])
		expect(declared.schemas["Table"]).toEqual(itemSchema(entities[0] ?? TABLE))
	})
})
