import { describe, expect, it } from "vitest"
import { createMemoryServer } from "../src/reference/http.ts"
import { Client } from "../src/runtime/client.ts"
import { resolvePathScope } from "../src/runtime/world.ts"
import { buildModel } from "../src/spec/graph.ts"
import { dereference } from "../src/spec/load.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

describe("an ancestor two lanes need at once", () => {
	it("is created once and shared", async () => {
		const server = await createMemoryServer()
		try {
			const spec = (await (await fetch(`${server.url}/v1/openapi/spec`)).json()) as OpenApiDocument
			const model = buildModel(dereference(spec).doc)
			const rowCreate = model.byOperationId.get(model.entities.get("row")?.create ?? "")
			expect(rowCreate?.pathParams).toContain("table_id")
			const client = new Client(server.url)
			const ancestors = new Map<string, string>()
			const created: string[] = []
			const options = {
				ancestors,
				authHeaders: () => ({ authorization: "Bearer tok_alpha" }),
				onCreate: (entity: string, id: string) => created.push(`${entity} ${id}`),
				principal: "alpha",
				roots: { project_id: "proj_alpha" },
				seed: 1,
			}
			const [first, second] = await Promise.all([
				resolvePathScope(rowCreate!, model, client, options),
				resolvePathScope(rowCreate!, model, client, options),
			])
			expect(created.filter((entry) => entry.startsWith("table "))).toHaveLength(1)
			expect(first.values.table_id).toBe(second.values.table_id)
		} finally {
			await server.close()
		}
	})
})
