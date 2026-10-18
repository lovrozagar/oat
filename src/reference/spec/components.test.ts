import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
import { shapedEntities } from "../model/shaped.ts"
import { TABLE } from "../model/table.ts"
import { components } from "./components.ts"
import { itemSchema } from "./schemas.ts"

describe("components", () => {
	it("declares the error schemas, the shared Point and recursive TreeNode, and bearer auth", () => {
		const declared = components({ entities: ENTITIES, shape: {} }) as { schemas: Record<string, unknown> }
		expect(Object.keys(declared.schemas).slice(-3)).toEqual(["Error", "Point", "TreeNode"])
		expect(declared.schemas.TreeNode).toHaveProperty("properties.children.items", {
			$ref: "#/components/schemas/TreeNode",
		})
		expect(declared).toHaveProperty("securitySchemes.bearer", { bearerFormat: "JWT", scheme: "bearer", type: "http" })
	})

	it("declares each entity's record schema under the layout shape", () => {
		const shape = { specLayout: true }
		const entities = shapedEntities(shape)
		const declared = components({ entities, shape }) as { schemas: Record<string, unknown> }
		expect(Object.keys(declared.schemas).slice(-3)).toEqual(["Table", "Row", "Job"])
		expect(declared.schemas.Table).toEqual(itemSchema(entities[0] ?? TABLE))
	})
})
